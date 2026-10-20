# Protocolo de Ejecución de Tareas con Agentes

**Versión:** 1.3 · **Fecha:** 2026-10-20
**Deriva de:** `docs/constitution.md` §8 · **Aplica a:** toda feature `NNN-nombre/`

Este documento es el detalle operativo de la constitución §8: cómo se implementa una tarea de `tasks.md` con la skill orquestadora, sus subagentes y sus hooks. `tasks.md` no menciona nada de esto; solo lista tareas.

---

## 1. Piezas

| Pieza | Ruta | Qué es |
|---|---|---|
| Skill orquestadora | `.claude/skills/implement-task/SKILL.md` | `/implement-task TASK-XXX`. La corre la sesión principal. Es la única que hace commit. |
| Skill de coordinación | `.claude/skills/coordinar-fases/SKILL.md` | `/coordinar-fases`: hace en bucle las tareas asignadas a la persona en las ramas de grupo, con `/implement-task` (§5.2). |
| Subagentes | `.claude/agents/test-author.md` · `implementer.md` · `sdd-auditor.md` | Una etapa del pipeline cada uno (§3). |
| Hook de agente | `.claude/settings.json` → `SubagentStop` | Ejecuta `tools/sdd/gate.mjs` (§4.1), solo para `test-author`, `implementer` y `sdd-auditor`. |
| Hook de sesión | `.claude/settings.json` → `SessionStart` | Ejecuta `tools/sdd/session-brief.mjs` (§4.3): al abrir Claude, un resumen de la rama, la tarea activa, el avance y las tareas disponibles. |
| Hook de git | `.githooks/pre-push` | Ejecuta `tools/sdd/pre-push.mjs` (§4.2). Se activa con `git config core.hooksPath .githooks`. |
| Scripts | `tools/sdd/*.mjs` | Node, sin dependencias: `task-parse`, `preflight`, `context`, `state` (único punto de cambio del estado), `audit` (registra veredictos), `gate`, `check` (corre los controles del gate sin gastar intentos), `close` (marca `[x]` y hace el commit), `session-brief` (resumen al abrir una sesión), `coordinate` (qué tarea le toca a cada persona, §5.2) y `pre-push`. Los controles de los gates viven en `lib/gates.mjs` y los comparten `gate` y `check`. Los usan los hooks, los subagentes y la skill. Sus pruebas: `node --test tools/sdd/test/*.test.mjs`. |
| Estado de ejecución | `.claude/run/` (ignorado por git) | `active-task.json` y una carpeta por tarea (§2.2). |

---

## 2. Skill `/implement-task TASK-XXX`

### 2.1 Flujo

```
0 Preflight ─► 1 test-author ─► [Gate A] ─► 2 implementer ─► [Gate B] ─► 3 sdd-auditor ─► 4 Cierre
                                                 ▲                              │
                                                 └── CHANGES_REQUIRED (máx. 2) ─┘
```

| Paso | Quién | Qué hace |
|---|---|---|
| 0 · Preflight | `tools/sdd/preflight.mjs` | Verifica que la tarea exista y esté `[ ]`, que sus dependencias estén `[x]`, que el árbol de trabajo esté limpio y que no haya otra tarea activa sin cerrar. Ubica la rama (§5). Arma el paquete de contexto (§2.3) y escribe `active-task.json`. |
| 1 · Pruebas | Subagente `test-author` | Con `phase = tests`. Se salta si el alcance no tiene archivos de test (§6). |
| 2 · Implementación | Subagente `implementer` | Con `phase = implement`. Se salta en una **tarea de verificación**: aquella cuyo alcance solo tiene archivos de test (regresión, RNF, harness). |
| 3 · Auditoría | Subagente `sdd-auditor` | Con `phase = audit`. El orquestador registra su veredicto con `audit.mjs`, que valida el formato y lo agrega a `audit.md`. Si es `CHANGES_REQUIRED`, vuelve al paso 2 con los hallazgos agregados al contexto. |
| 4 · Cierre | Orquestador | Con `phase = commit`, ejecuta `close.mjs`: marca `[x]` en `tasks.md`, hace el commit (§5) y borra `active-task.json`. Si la tarea es la última de su fase, ofrece abrir el PR. |

Volver a invocar la skill sobre una tarea `blocked` la retoma desde la fase en la que se detuvo.

### 2.2 Estado

`.claude/run/active-task.json`:

```json
{
  "task": "TASK-031",
  "feature": "001-appFinanzas-mvp",
  "branch": "feature/09-m4-cuentas",
  "phase": "preflight | tests | implement | audit | commit",
  "status": "running | blocked",
  "blockedReason": null,
  "scope": ["apps/api/src/application/services/accounts.service.ts", "apps/api/test/integration/accounts-create-list.test.ts"],
  "testFiles": ["apps/api/test/integration/accounts-create-list.test.ts"],
  "implFiles": ["apps/api/src/application/services/accounts.service.ts"],
  "commands": [],
  "verificationOnly": false,
  "gates": { "A": { "attempts": 0, "passed": false }, "B": { "attempts": 0, "passed": false } },
  "auditRounds": 0,
  "auditFingerprint": null
}
```

El estado solo cambia con `tools/sdd/state.mjs` (`phase`, `block`, `unblock`, `abort`), que valida cada transición: por ejemplo, no se pasa a `audit` sin el Gate B aprobado ni a `commit` sin un veredicto `APPROVED`.

`.claude/run/TASK-XXX/`: `context.md` (paquete de contexto), `tests.lock` (hash de las pruebas), `verdict.md` (última respuesta del auditor), `audit.md` (veredictos de todas las rondas), `gate.log` (salida de cada gate) y `commit-msg.txt`.

### 2.3 Paquete de contexto

Cada subagente recibe solo `context.md`, armado por `tools/sdd/context.mjs`:
1. el bloque completo de la tarea en `tasks.md`;
2. `docs/constitution.md` completa (es corta);
3. las convenciones del plan, las filas de los ADR citados y las secciones de `plan.md` citadas en su Trazabilidad, completas;
4. el texto literal de cada RN, RF, EC y RNF citado, y de cada escenario Gherkin citado en sus criterios, tomado de `spec.md`;
5. en una segunda ronda, los hallazgos de la auditoría anterior.

Si un subagente necesita leer otro archivo del repositorio (por ejemplo, un puerto que ya existe), puede hacerlo; lo que no puede es escribir fuera del alcance.

---

## 3. Subagentes

| Subagente | Herramientas | Puede escribir | Responsabilidad | Termina con |
|---|---|---|---|---|
| `test-author` | Read, Grep, Glob, Write, Edit, Bash | Solo los archivos de test del alcance | Escribe las pruebas a partir de los «Criterios de verificación» y de los escenarios Gherkin citados. Cada caso lleva en su nombre el ID que verifica (`it('RF-M4-04 …')`, plan §5.4) o, si no hay ID, el de la tarea. No mira ninguna implementación de la tarea. | Pruebas en rojo |
| `implementer` | Read, Grep, Glob, Write, Edit, Bash | Solo los archivos del alcance que no son de test | Escribe el código hasta poner las pruebas en verde, siguiendo el plan: capas (ADR-19), dinero exacto (ADR-03), identidad desde la sesión (ADR-05), errores (ADR-09) y textos en `locales/es-BO`. No modifica las pruebas de la etapa 1. | Código en verde |
| `sdd-auditor` | Read, Grep, Glob, Bash (solo lectura: `git diff`, `git status`) | Nada | Revisa el diff contra la constitución, el plan y el texto de la spec: reglas de negocio inventadas, RF o EC sin cubrir, reglas de capas, dinero en punto flotante, `userId` tomado del cliente, secretos o detalles internos expuestos, textos sin traducir. | Un veredicto (§3.1) |

### 3.1 Veredicto de la auditoría

La respuesta final del auditor empieza con una de estas líneas:

- `VERDICT: APPROVED`
- `VERDICT: CHANGES_REQUIRED`, seguido de los hallazgos, uno por línea: `archivo:línea · regla violada (constitución §x, plan §x.y, RF-xx) · corrección esperada`.
- `VERDICT: NEEDS_CLARIFICATION`, seguido de la pregunta de negocio y las opciones.

### 3.2 Paradas

Cualquier subagente puede terminar su trabajo con una de estas líneas, como **primera línea** de su respuesta. El gate no lo juzga ni le gasta intentos: deja la tarea en `status = blocked` con ese motivo, y el orquestador le pregunta al usuario.

- `NEEDS_CLARIFICATION: <pregunta>`: la spec o el plan son ambiguos (constitución §6).
- `SCOPE_CHANGE_REQUEST: <archivo> · <motivo>`: hace falta un archivo fuera del alcance. Se corrige `tasks.md` en un commit `docs:` y se retoma.

---

## 4. Hooks

### 4.1 `SubagentStop` → `tools/sdd/gate.mjs`

Lee `active-task.json` y aplica el gate de la fase. Si un control falla, bloquea el cierre del subagente y le devuelve el error como motivo, para que siga trabajando. Sin tarea activa, o con la tarea bloqueada, no hace nada.

- **A quién juzga:** el *matcher* del hook lo limita a los tres subagentes del pipeline. Además, el gate lee `agent_type` de la entrada del hook y solo juzga al subagente de la fase vigente: `test-author` en `tests`, `implementer` en `implement` y `sdd-auditor` en `audit`. Un subagente de exploración que termine durante una tarea no consume intentos.
- **Paradas:** si `last_assistant_message` empieza con `NEEDS_CLARIFICATION` o `SCOPE_CHANGE_REQUEST` (§3.2), no corre los controles: bloquea la tarea con ese motivo y deja terminar al subagente.
- **Autoverificación:** antes de terminar, el test-author y el implementer corren `node tools/sdd/check.mjs`. Aplica los mismos controles del gate de la fase (`lib/gates.mjs`), pero sin gastar intentos, y sale con código 0 si el gate pasaría. Si el Gate B pasaría y el árbol de trabajo no cambió mientras corría, anota su huella en el estado y el hook de cierre reutiliza ese resultado en lugar de repetir los controles (basta que cambie un archivo, o que haya otra ronda, para que se corran de nuevo). Así, la mayoría de los errores (tipos, lint, comandos, alcance) se corrigen antes de que cuente un intento.

**Gate A (`phase = tests`):**
1. Los archivos cambiados o nuevos (`git status --porcelain`) son solo archivos de test del alcance.
2. Existe al menos un caso de prueba, y cada caso lleva un ID `RN-`, `RF-`, `EC-`, `RNF-` o `TASK-` en su nombre.
3. Cada RF y EC citado en la Trazabilidad de la tarea tiene al menos un caso con su ID en el nombre, en la tarea o en el repositorio (adelanta el control 4 del `pre-push`).
4. Las pruebas corren y **fallan**. Un error de sintaxis en el propio archivo de test no cuenta como rojo. En una tarea de verificación (§2.1), las pruebas deben **pasar**, porque verifican algo que ya existe; si siguen fallando después de los intentos, el pipeline se detiene y pregunta, ya que el defecto puede estar fuera del alcance de la tarea.
5. Si todo pasa, guarda el hash SHA-256 de cada archivo de test en `tests.lock`.

**Auditoría (`phase = audit`):** al pasar a esta fase, `state.mjs` guarda una huella del árbol de trabajo. Cuando el auditor termina, el gate la compara: si algo cambió, deja terminar al auditor, marca la tarea `blocked` y el orquestador le pregunta al usuario.

**Error interno del gate:** si el propio script falla, deja terminar al subagente y marca la tarea `blocked` con el error.

**Gate B (`phase = implement`):**
1. Los archivos cambiados o nuevos están dentro del alcance.
2. Los hashes de `tests.lock` no cambiaron.
3. Typecheck (`tsc --noEmit`) de cada workspace tocado.
4. ESLint de los archivos cambiados (incluye `i18next/no-literal-string` y la prohibición de `.only` y `.skip`).
5. dependency-cruiser, si se tocó `apps/api`.
6. Las pruebas de la tarea y `vitest related` de los archivos cambiados, en verde. Si alguna es de integración, levanta antes Postgres con `docker compose up -d`.
7. Los comandos de la tarea (`commands`, §6), si los hay, terminan con código 0.

**Límites:** cada gate bloquea como máximo 3 veces por tarea. A la cuarta falla deja cerrar al subagente, marca `status = blocked` con la salida en `gate.log`, y el orquestador le pregunta al usuario.

**Resultados obsoletos:** los controles tardan, y mientras corren el orquestador puede cambiar de fase (un subagente puede terminar tarde). Cada cambio de fase, `block` y `unblock` incrementa `epoch` en `active-task.json`. Antes de guardar, el gate relee el estado: si la tarea, la fase, `epoch` o `status` ya no son los que vio al empezar, descarta su resultado, lo anota en `gate.log` y deja terminar al subagente sin tocar el estado.

### 4.2 `pre-push` → `tools/sdd/pre-push.mjs`

Revisa los commits que se van a subir (los que no están en el remoto) y su diff. Si alguno de estos controles falla, el push se rechaza:
1. **commitlint** sobre cada commit (constitución §7).
2. **Secretos:** ningún archivo `.env*` salvo `.env.example`, y ningún valor con forma de clave, token o URL de base de datos con contraseña.
3. **Trazabilidad:** cada commit con el trailer `Task: TASK-XXX` tiene esa tarea en `[x]` en `tasks.md` y el trailer `Audit: approved`.
4. **Cobertura de IDs:** cada RF y EC citado en la Trazabilidad de las tareas cerradas aparece en el nombre de al menos un test del repositorio (plan §5.4.1).

Son controles de segundos. La suite completa (lint, typecheck, dependency-cruiser, unitarios e integración) no corre en el `pre-push`: la corre CI en cada push y PR (§4.4), y la protección de `develop` exige que pase antes de fusionar. Ahí se detectan las regresiones entre tareas, porque el Gate B solo corre las pruebas relacionadas. Los E2E completos, axe y rendimiento también corren en CI (`qa-e2e.yml`).

### 4.3 `SessionStart` → `tools/sdd/session-brief.mjs`

Al abrir, retomar, limpiar o compactar una sesión de Claude en el proyecto, le agrega al contexto un resumen corto de dónde quedó el trabajo, para que cada integrante retome sin buscar a mano:
- la rama actual, y si el árbol de trabajo está limpio;
- la tarea activa, con su etapa y su estado; si está `blocked`, el motivo;
- el avance: tareas cerradas sobre el total, y las de la fase en curso;
- hasta 5 tareas disponibles, es decir, abiertas con todas sus dependencias cerradas.

El texto lo arma `lib/brief.mjs`, una función pura con sus pruebas. El hook solo lee: no cambia archivos ni el estado, y no participa en el pipeline. Si algo no se puede leer (no hay `tasks.md`, el estado está corrupto o no es un repositorio git), omite ese dato y sale igual con código 0: nunca impide abrir una sesión.

### 4.4 Controles que no son hooks

- La protección de ramas de GitHub impide el push directo a `develop`, `qa` y `main` (plan 1.5).
- CI repite lint, tipos, capas, commitlint y tests en cada push y PR.
- El auditor no tiene herramientas de escritura en su definición.

---

## 5. Ramas, commits y PR

- **Una rama por fase de `tasks.md`**, salida de `develop`: `feature/<NN>-<slug-de-la-fase>` (por ejemplo, `feature/04-m4-cuentas`). Si el preflight corre en `develop`, crea la rama de la fase de la tarea; si corre en otra rama de feature, exige que sea la de esa fase.
- **Un commit por tarea**, hecho por el orquestador:

  ```
  feat(accounts): TASK-031 implementar AccountsService.create

  <resumen de lo implementado>

  Task: TASK-031
  Audit: approved
  ```

  El tipo es `feat`, `test`, `chore`, `build` o `ci` según la tarea, y el scope es el módulo o el paquete. `close.mjs` pone el ID de la tarea, corta el cuerpo a 100 columnas y pasa el mensaje por commitlint antes de hacer el commit, así un mensaje inválido no aparece recién en el `pre-push`.
- **Traer `develop` a la rama** con un merge es válido: el `pre-push` y commitlint no revisan el asunto de los merges que escribe git.
- **Un PR a `develop`** al cerrar la última tarea de la fase. Antes corre el `pre-push`, y el PR se fusiona con CI en verde.
- Corregir `tasks.md`, `plan.md` o `spec.md` es un commit `docs:` aparte, nunca mezclado con código (constitución §6).

### 5.1 Ramas de grupo

Para trabajar en paralelo una cadena de fases, varias fases pueden repartirse entre **ramas de grupo**, definidas en [`tools/sdd/branch-groups.json`](../tools/sdd/branch-groups.json). Cada grupo tiene su rama y la lista de sus tareas (con rangos como `TASK-068..TASK-076`). Una tarea está como mucho en un grupo; las que no están en ninguno siguen la regla de una rama por fase.

- **Preflight:** una tarea de un grupo se hace en la rama del grupo. Desde `develop`, el preflight cambia a esa rama: la local, la de `origin` (con seguimiento) o, si no existe, una nueva. Una tarea que ya estaba a medio hacer se retoma en la rama donde empezó.
- **Dependencias entre grupos:** el preflight sigue exigiendo que las dependencias estén `[x]` en el `tasks.md` de la rama. Si una tarea depende de otra que se cerró en el otro grupo, se trae esa rama con un merge (`git merge origin/<rama-del-otro-grupo>`).
- **Cierre y PR:** `close.mjs` responde `lastOfPhase: true` cuando no quedan tareas abiertas en la rama (todo el grupo), y ahí se abre el PR a `develop`. Se puede abrir antes un PR parcial si el otro grupo necesita algo con urgencia.
- **Resumen de sesión:** en una rama de grupo, el resumen muestra el avance del grupo y solo sus tareas disponibles.
- Cambiar el reparto es editar `branch-groups.json` en un commit `chore(sdd):` aparte y avisar al equipo.

### 5.2 Asignaciones y coordinación entre personas

En las ramas de grupo trabajan varias personas a la vez, cada una con su Claude Code. Cada tarea tiene una sola persona, y nadie elige tareas: las asigna la tabla de [`docs/asignaciones.md`](asignaciones.md) (`| TASK-NNN..TASK-MMM | @usuario |`, con el usuario de GitHub). Una persona puede tener tareas en las dos ramas de grupo.

- **Qué me toca:** `node tools/sdd/coordinate.mjs next` hace `git fetch` y decide con el `tasks.md` de cada rama de grupo y de `develop` en `origin`: una tarea está cerrada si está `[x]` en alguna. Devuelve la primera tarea propia con todas sus dependencias cerradas, su rama y las ramas que hay que traer con un merge (`implement`); o qué tareas propias esperan a cuáles, de quién y en qué rama (`wait`); o que una espera a una tarea sin persona (`stuck`). La lógica es `lib/coordination.mjs`, una función pura con sus pruebas.
- **Quién soy:** `git config sdd.member <usuario-de-github>`, una vez por copia. Si no está, el script usa el usuario de `gh`.
- **La señal es el push:** una tarea está hecha para los demás cuando su `[x]` llega a `origin`. Por eso `/coordinar-fases` sube cada tarea apenas `close.mjs` hace el commit, y si el push se rechaza trae los cambios con un merge (nunca rebase) y reintenta.
- **Esperar sin gastar:** `node tools/sdd/coordinate.mjs wait` repite el `fetch` cada 3 minutos y termina cuando la acción deja de ser `wait` (o a las 12 horas). La skill lo corre en segundo plano y retoma cuando termina.
- **Estado del equipo:** `node tools/sdd/coordinate.mjs status` dice qué le toca a cada persona y qué tareas abiertas de un grupo no tienen a nadie.
- **Paradas:** si `/implement-task` se detiene, un merge choca o el `pre-push` falla, `/coordinar-fases` se detiene y la persona decide. Quien espera esa tarea sigue esperando hasta que se suba.
- **Cambiar el reparto:** las asignaciones se leen de la copia local, que `/coordinar-fases` actualiza con un `pull` antes de cada tarea. Se cambian con un commit `chore(sdd):` aparte que se sube a las dos ramas de grupo, avisando al equipo.
- **Permisos:** `git switch`, `pull`, `merge` y `push` piden permiso en el modo normal. Para que el bucle no se frene, cada persona elige su modo de permisos (por ejemplo, el automático).

---

## 6. Formato de `tasks.md` que leen los scripts

`tools/sdd/task-parse.mjs` espera esto en cada tarea:

- Encabezado: `` - [ ] **`TASK-NNN`: <título>** `` (tres dígitos; `[x]` cuando está cerrada).
- **Dependencias:** `Ninguna` o los IDs `TASK-NNN` separados por comas.
- **Trazabilidad SDD:** cita `plan §x.y.z` y los IDs exactos de la spec (`RF-M4-04`, `EC-M4-01`, `RNF-10`, `RN-06`).
- **Archivos en Alcance:** una ruta entre backticks por viñeta, relativa a la raíz. Solo se admiten globs en `packages/db/prisma/migrations/`.
- **Criterios de Verificación:** las líneas `` Comando: `…` `` son comandos que el Gate B ejecuta y que deben terminar con 0. Se escriben con sintaxis POSIX y corren en `sh` (en Windows, el bash de Git; nunca `cmd.exe`).
- **Pasos manuales** (opcional, después de los cinco obligatorios): lo que una persona tiene que hacer fuera del pipeline, como crear cuentas, configurar paneles o cargar secretos. Va como lista numerada, con sangría de 4 espacios. Los scripts no lo leen y los subagentes no lo ejecutan ni lo auditan. Al cerrar la tarea, el orquestador se lo muestra al usuario como una lista para ir marcando.

Un archivo es de test si coincide con `**/*.test.ts`, `**/*.test.tsx`, `**/*.spec.ts`, `**/test/**` o `e2e/**`. Las fases se marcan con encabezados `### Fase N — <nombre>` y definen la rama (§5).

**Reparto del alcance** (`splitScope` en `tools/sdd/lib/scope.mjs`): test-author escribe los archivos de test, salvo los manifiestos y las configuraciones (`package.json`, `tsconfig.json`, `*.config.*`), que siempre escribe el implementer porque es quien instala. Si la tarea no tiene ningún archivo con casos de prueba (`*.test.*`, `*.spec.*`), sus archivos de test son solo harness y también los escribe el implementer: la tarea no pasa por la etapa de pruebas.

**Huecos de alcance** (`scopeProblems` en `tools/sdd/lib/tasks.mjs`): `preflight.mjs` no arranca una tarea con un hueco que haría fallar un gate sin que el subagente pueda corregirlo, y `sdd.test.mjs` revisa todas las tareas abiertas:
- Si una tarea toca un `package.json`, también tiene `pnpm-lock.yaml` en su alcance.
- Cada `.ts` o `.tsx` del alcance cae en el `tsconfig.json` de su paquete (`apps/*`, `packages/*` o `e2e`), creado en esa tarea o en una anterior. Por eso cada `tsconfig.json` de paquete cubre todas sus carpetas, también las que agregarán tareas posteriores. El JS de configuración (`*.js`, `*.cjs`, `*.mjs`) se revisa con ESLint sin información de tipos, así que no necesita un tsconfig.
- Si una tarea crea un `global-setup` de Vitest en `test/`, también tiene el `vitest.config.ts` de su paquete en el alcance, porque hay que registrarlo ahí.

---

## 7. Arranque

- La skill, los subagentes, los hooks y `tools/sdd/` se construyen en una sesión dedicada **antes de TASK-001**, fuera de `tasks.md`, porque el pipeline no puede construirse a sí mismo. Esa sesión también agrega `.claude/run/` a `.gitignore`.
- Hasta que existan el monorepo y sus scripts, `gate.mjs` salta con aviso los controles cuya herramienta todavía no está instalada (typecheck, lint, dependency-cruiser, Vitest).
- Durante el arranque, `core.hooksPath` se configura a mano. Desde la Fase 0, lo hace el script `prepare` del `package.json` raíz.
