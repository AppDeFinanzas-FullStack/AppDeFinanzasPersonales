---
name: fast-task
description: Modo rápido de /implement-task. Implementa una tarea de tasks.md (TASK-NNN) directamente, sin subagentes, sin pruebas nuevas, sin gates ni auditoría; solo typecheck y lint, y cierra con un commit "Audit: skipped". Usar cuando el usuario pida implementar una tarea en modo rápido, sin tests, o con /fast-task.
argument-hint: TASK-NNN
---

# /fast-task — Implementar una tarea sin pipeline

Decisión del equipo (2026-10-20): por falta de tiempo, las tareas hasta la Fase 12 se implementan sin escribir pruebas nuevas y sin la auditoría. El CI de GitHub sigue corriendo toda la suite en cada PR, así que **no rompas pruebas que ya existen**.

La tarea viene en `$ARGUMENTS`. Si no hay un ID `TASK-NNN`, pregunta cuál.

## Reglas
1. **No lances subagentes** (`test-author`, `implementer`, `sdd-auditor`). Escribes el código tú.
2. **No escribas pruebas.** Ignora los archivos de prueba del alcance.
3. Solo tocas los archivos de implementación del alcance (`implFiles`). Si de verdad necesitas otro, detente y dile al usuario qué archivo y por qué (se corrige el alcance en `tasks.md` con un commit `docs:` aparte).
4. Nada de `--no-verify`, ni push directo a `develop`, `qa` o `main`.

## Paso 1 — Preflight
```
node tools/sdd/preflight.mjs <TASK>
```
Si falla, muestra el motivo y detente. Si `resume` es `true`, sigue con lo que ya haya en el árbol de trabajo.

## Paso 2 — Implementar
1. Lee `.claude/run/<TASK>/context.md` (la tarea, la spec, el plan y la constitución que aplican). Si `uiTask` es `true`, sigue `docs/design-direction.md`.
2. Implementa lo que pide la "Especificación de Implementación" con el estilo de lo que ya existe en el repositorio: capas del backend (ADR-19), dinero como decimal exacto en texto (ADR-03), identidad desde la sesión (ADR-05), código en inglés y textos de la interfaz en `locales/es-BO`.
3. Sin `TODO`, código comentado ni `console.log`. No inventes reglas de negocio.

## Paso 3 — Verificación mínima
Solo en los paquetes que tocaste (`api`, `web`, `contracts`, `domain` o `db`):
```
pnpm --filter @finanzas/<paquete> typecheck
pnpm exec eslint --max-warnings=0 <archivos tocados>
```
Corrige hasta que estén en verde. No corras la suite de pruebas.

## Paso 4 — Cierre
```
node tools/sdd/close.mjs --mode fast --type <feat|fix|chore…> --scope <módulo> --summary "<resumen en inglés, imperativo, sin el ID>" --body "<2-4 líneas>" --trailer "<línea de atribución de commits de esta sesión, si la hay>"
```
El script marca `[x]` en `tasks.md` y hace el commit con `Task:` y `Audit: skipped`. Después sube la rama (`git push`) para que el resto del equipo tenga la tarea.

Informa en pocas líneas: tarea, commit y archivos. Si la tarea tiene **«Pasos manuales»**, muéstraselos al usuario como pendientes. Si `close.mjs` responde `lastOfPhase: true`, ofrece abrir el PR a `develop` (`gh pr create --base develop`) y hazlo solo si el usuario lo confirma.
