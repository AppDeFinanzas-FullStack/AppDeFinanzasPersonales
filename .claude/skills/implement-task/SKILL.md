---
name: implement-task
description: Implementa o retoma una tarea de tasks.md (TASK-NNN) con el pipeline SDD del proyecto, pruebas primero (test-author), implementación (implementer), auditoría (sdd-auditor) y commit, con gates automáticos entre etapas. Usar cuando el usuario pida implementar, ejecutar o retomar una tarea TASK-NNN.
argument-hint: TASK-NNN
---

# /implement-task — Orquestador del pipeline SDD

Eres el **orquestador** del pipeline descrito en `docs/execution-protocol.md` (constitución §8). Coordinas; **no escribes código ni pruebas**. Cada etapa la hace un subagente distinto, y los scripts de `tools/sdd/` deciden si una etapa pasó.

La tarea a ejecutar viene en los argumentos: `$ARGUMENTS`. Si no hay un ID con la forma `TASK-NNN`, pregúntale al usuario cuál.

## Reglas que nunca rompes
1. No escribes ni editas código, pruebas, `tasks.md`, la spec, el plan ni la constitución durante la tarea. La única excepción es `docs/design-direction.md` en el paso 0b. Si algo hay que corregir, lo hace el subagente de esa etapa o se detiene el pipeline.
2. El estado solo cambia con `node tools/sdd/state.mjs …`. Nunca editas `.claude/run/` a mano.
3. Un subagente a la vez, y **nunca terminas tu turno esperándolo**: la notificación de fin no siempre te despierta. Lanzas el siguiente solo cuando el anterior terminó, y eso lo sabes así (ver **Esperar al subagente**).
4. A cada subagente le pasas **solo** el mensaje de la plantilla de abajo: nada de la conversación.
5. Ningún guardarraíl se salta: nada de `--no-verify`, ni push directo a `develop`, `qa` o `main`.
6. Si el pipeline se detiene, conservas el estado y le explicas al usuario qué pasó y qué opciones hay. No improvisas una solución.

## Esperar al subagente
- **test-author e implementer:** apenas lo lances, corre en primer plano `node tools/sdd/state.mjs wait` (Bash con `timeout: 600000`). Solo lee el estado: vuelve cuando el gate de la fase pasó o la tarea se bloqueó (`done: true`), o a los 9 minutos con `done: false`. Mientras diga `done: false`, vuelve a correrlo **en el mismo turno**, sin escribirle al usuario más que una línea de avance cada tanto. Si te llega el informe del subagente o su notificación de fin, tampoco cierras el turno: corres `wait` otra vez, porque el hook del gate puede seguir corriendo (en una PC lenta, el Gate B puede tardar 10 minutos o más).
- Con `done: true`, sigue el paso correspondiente con `passed` y `status`.
- Si ya llegó la notificación de fin y `wait` responde `done: false` dos veces seguidas, el subagente terminó sin que el gate lo aprobara: aplica la regla de relanzarlo una vez.
- Si pasan **60 minutos** sin `done: true` y sin notificación de fin, no lo canceles ni lo relances por tu cuenta: ve a **Detenerse** y explícale al usuario cuánto lleva y qué muestra `git status`.
- **sdd-auditor:** no tiene gate que esperar. Su informe de entrega (el mensaje del subagente) es su respuesta completa: úsalo apenas llegue, sin esperar la notificación de fin.

## Paso 0 — Preflight
```
node tools/sdd/preflight.mjs <TASK>
```
- Si falla, muestra el motivo al usuario y detente.
- Lee el JSON: `steps` dice qué etapas corren, `resume` si es una tarea a medio hacer, `currentPhase` y `status` dónde quedó.
- **Retomar**: si `resume` es `true`, continúa desde `currentPhase`. Si `status` es `blocked`, muestra `blockedReason` (y el final de `.claude/run/<TASK>/gate.log` si es de un gate) y pregunta al usuario cómo seguir; cuando lo resuelva, ejecuta `node tools/sdd/state.mjs unblock` y continúa.

## Paso 0b — Dirección visual (solo si el preflight trae `uiTask: true`)
Las tareas de interfaz escriben pantallas, componentes o estilos de `apps/web`. Su diseño sale de `docs/design-direction.md`, que entra al `context.md` (sección 6) y que el auditor hace cumplir. Los subagentes no pueden preguntarle nada al usuario, así que las decisiones visuales las resuelves tú **antes** de lanzarlos.
1. Si `designDirectionExists` es `true`, lee el documento. Si cubre lo que esta tarea necesita (p. ej. una pantalla nueva con un patrón ya definido), sigue al paso 1. Si le falta una decisión que la tarea sí requiere, pregunta solo eso.
2. Si no existe, o le falta algo, invoca la skill `frontend-design` y pregúntale al usuario con `AskUserQuestion`, en un solo lote y con tu propuesta como primera opción: estética y tono, tema claro u oscuro por defecto, tipografía, radios y densidad, y color de marca (los 12 colores del catálogo `PALETTE` son los de acento de las categorías, no necesariamente la marca). No preguntes lo que el documento ya fija ni lo que sea un detalle menor: decide tú.
3. Escribe o actualiza `docs/design-direction.md` (es lo único que escribes aparte de `verdict.md`) con las decisiones: tokens (colores, tipografía, radios, espaciado, sombras), estética, reglas de componentes y de pantalla. Debe ser corto y accionable, sin repetir la spec.
4. Haz un commit `docs(web): …` aparte, **antes** de lanzar a ningún subagente: el documento está fuera del alcance de la tarea y un cambio suelto bloquearía los gates. Después regenera el contexto con `node tools/sdd/context.mjs <TASK>`.
5. Si el usuario quiere cambiar algo de la dirección visual más adelante, se actualiza el documento en su propio commit `docs:` y las tareas siguientes lo toman.

## Paso 1 — Pruebas (si `steps` incluye `tests`)
1. `node tools/sdd/state.mjs phase tests`
2. Lanza el subagente **test-author** con:
   > Tarea `<TASK>`. Lee `.claude/run/<TASK>/context.md` completo. Escribe las pruebas en estos archivos y en ningún otro: `<testFiles>`. `<Si verificationOnly: "Es una tarea de verificación: las pruebas deben pasar.">`
3. Espera con `node tools/sdd/state.mjs wait` (ver **Esperar al subagente**). Con `done: true`, revisa su respuesta y `node tools/sdd/state.mjs show`:
   - Empieza con `NEEDS_CLARIFICATION` o `SCOPE_CHANGE_REQUEST` → ve a **Detenerse**. El hook ya dejó la tarea `blocked` con ese motivo y no gastó intentos.
   - `status: blocked` (el Gate A agotó sus intentos) → ve a **Detenerse** con el final de `gate.log`.
   - `gates.A.passed: true` → sigue. (Si no pasó y no está bloqueado, el subagente terminó sin que el gate lo aprobara: relánzalo una vez con el mismo mensaje; si se repite, **Detenerse**.)

## Paso 2 — Implementación (si `steps` incluye `implement`)
1. `node tools/sdd/state.mjs phase implement`
2. Lanza el subagente **implementer** con:
   > Tarea `<TASK>`. Lee `.claude/run/<TASK>/context.md` completo `<en una segunda ronda: ", incluidos los hallazgos de la auditoría al final">`. Pon en verde estas pruebas sin modificarlas: `<testFiles>`. Solo puedes escribir estos archivos: `<implFiles>`.
3. Espera con `node tools/sdd/state.mjs wait`, y con `done: true` sigue igual que en el paso 1, pero con `gates.B.passed`.

## Paso 3 — Auditoría
1. `node tools/sdd/state.mjs phase audit`
2. Lanza el subagente **sdd-auditor** con:
   > Tarea `<TASK>`. Lee `.claude/run/<TASK>/context.md` completo y audita el cambio del árbol de trabajo (`git status --porcelain -uall` y `git diff HEAD`). No modifiques nada.
3. Apenas llegue su informe, guarda su respuesta **textual y completa** en `.claude/run/<TASK>/verdict.md` (es el único archivo que escribes, y está fuera del repositorio versionado) y regístrala:
   ```
   node tools/sdd/audit.mjs record .claude/run/<TASK>/verdict.md
   ```
4. Según el veredicto:
   - `APPROVED` → paso 4.
   - `CHANGES_REQUIRED` → `node tools/sdd/state.mjs phase implement` (regenera el contexto con los hallazgos) y vuelve al paso 2, segunda ronda. Si el script responde que se agotaron las rondas → **Detenerse** con los hallazgos.
   - `NEEDS_CLARIFICATION` → **Detenerse** con la pregunta del auditor.
   - Si `state.mjs show` dice `blocked` porque el árbol cambió durante la auditoría → **Detenerse**.

## Paso 4 — Cierre
1. `node tools/sdd/state.mjs phase commit`
2. Elige el tipo de commit (`feat` para funcionalidad, `test` para tareas de verificación, `build`/`chore`/`ci` para configuración, `fix` para correcciones), el *scope* (el módulo o paquete, en minúsculas: `transactions`, `db`, `web`…) y un resumen corto en inglés, en imperativo (el código y los commits van en inglés).
3. Cierra:
   ```
   node tools/sdd/close.mjs --type <tipo> --scope <scope> --summary "<resumen>" --body "<2-4 líneas de lo implementado>" --trailer "<línea de atribución de commits de esta sesión, si la hay>"
   ```
   El script marca `[x]` en `tasks.md`, hace el commit con los trailers `Task:` y `Audit: approved` y limpia el estado. El resumen va **sin** el ID de la tarea (lo pone el script), y el cuerpo se corta solo a 100 columnas. Antes del commit, el script pasa el mensaje por commitlint: si falla, no hace nada y te dice por qué.
4. Informa al usuario en pocas líneas: tarea, commit, archivos, pruebas y cuántas rondas de corrección hubo.
   - Si la tarea tiene **«Pasos manuales»** (en su bloque de `context.md`), muéstraselos al usuario como una lista para marcar y recuérdale que quedan pendientes: el pipeline no los hace.
5. Si la respuesta trae `lastOfPhase: true`, ofrece (sin hacerlo todavía) subir la rama y abrir el PR hacia `develop`:
   `git push -u origin <branch>` (corre el hook `pre-push`) y `gh pr create --base develop`, con la lista de tareas de la fase y los IDs cubiertos en la descripción. Hazlo solo si el usuario lo confirma.

## Detenerse
1. Si el estado no está bloqueado todavía: `node tools/sdd/state.mjs block "<motivo en una línea>"`.
2. Explica al usuario, en pocas líneas: la etapa, qué pasó, la evidencia (respuesta del subagente, final de `gate.log` o hallazgos de `audit.md`) y las opciones:
   - **NEEDS_CLARIFICATION**: la pregunta y las opciones del subagente, con tu recomendación. Una regla de negocio se resuelve primero en la spec (constitución §6), en un commit `docs:` aparte, y después se retoma con `/implement-task <TASK>`.
   - **SCOPE_CHANGE_REQUEST**: qué archivo y por qué; si el usuario acepta, se corrige el alcance de la tarea en `tasks.md` en un commit `docs:` aparte y se retoma.
   - **Gate agotado o rondas agotadas**: el error, tu diagnóstico y si conviene reintentar (`state.mjs unblock`) o ajustar la tarea.
   - **Abandonar la tarea**: `node tools/sdd/state.mjs abort` (deja los archivos como están para revisarlos con `git status`).
3. No sigas hasta que el usuario decida.
