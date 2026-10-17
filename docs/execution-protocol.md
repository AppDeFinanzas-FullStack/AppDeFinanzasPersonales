# Protocolo de Ejecución de Tareas con Agentes

**Versión:** 1.1 · **Fecha:** 2026-10-17
**Deriva de:** `docs/constitution.md` §8 · **Aplica a:** toda feature `NNN-nombre/`

Este documento es el detalle operativo de la constitución §8: cómo se implementa una tarea de `tasks.md` con la skill orquestadora, sus subagentes y sus hooks. `tasks.md` no menciona nada de esto; solo lista tareas.

---

## 1. Piezas

| Pieza | Ruta | Qué es |
|---|---|---|
| Skill orquestadora | `.claude/skills/implement-task/SKILL.md` | `/implement-task TASK-XXX`. La corre la sesión principal. Es la única que hace commit. |
| Subagentes | `.claude/agents/test-author.md` · `implementer.md` · `sdd-auditor.md` | Una etapa del pipeline cada uno (§3). |
| Hook de agente | `.claude/settings.json` → `SubagentStop` | Ejecuta `tools/sdd/gate.mjs` (§4.1). |
| Hook de git | `.githooks/pre-push` | Ejecuta `tools/sdd/pre-push.mjs` (§4.2). Se activa con `git config core.hooksPath .githooks`. |
| Scripts | `tools/sdd/*.mjs` | Node, sin dependencias: `task-parse`, `preflight`, `context`, `state` (único punto de cambio del estado), `audit` (registra veredictos), `gate`, `close` (marca `[x]` y hace el commit) y `pre-push`. Los usan los dos hooks y la skill. Sus pruebas: `node --test tools/sdd/test/sdd.test.mjs`. |
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

Cualquier subagente puede terminar su trabajo con una de estas líneas, y el pipeline se detiene (`status = blocked`) y le pregunta al usuario:

- `NEEDS_CLARIFICATION: <pregunta>`: la spec o el plan son ambiguos (constitución §6).
- `SCOPE_CHANGE_REQUEST: <archivo> · <motivo>`: hace falta un archivo fuera del alcance. Se corrige `tasks.md` en un commit `docs:` y se retoma.

---

## 4. Hooks

### 4.1 `SubagentStop` → `tools/sdd/gate.mjs`

Lee `active-task.json` y aplica el gate de la fase. Si un control falla, bloquea el cierre del subagente y le devuelve el error como motivo, para que siga trabajando. Sin tarea activa, o con la tarea bloqueada, no hace nada.

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
5. **Suite completa:** lint, typecheck, dependency-cruiser, unitarios e integración. Detecta las regresiones entre tareas, porque el Gate B solo corre las pruebas relacionadas.

Si el push solo cambia documentación (`docs/` o `NNN-*/*.md`), corren solo los controles 1 y 2. Los E2E completos, axe y rendimiento corren en CI (`qa-e2e.yml`).

### 4.3 Controles que no son hooks

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

  El tipo es `feat`, `test`, `chore`, `build` o `ci` según la tarea, y el scope es el módulo o el paquete.
- **Un PR a `develop`** al cerrar la última tarea de la fase. Antes corre el `pre-push`.
- Corregir `tasks.md`, `plan.md` o `spec.md` es un commit `docs:` aparte, nunca mezclado con código (constitución §6).

---

## 6. Formato de `tasks.md` que leen los scripts

`tools/sdd/task-parse.mjs` espera esto en cada tarea:

- Encabezado: `` - [ ] **`TASK-NNN`: <título>** `` (tres dígitos; `[x]` cuando está cerrada).
- **Dependencias:** `Ninguna` o los IDs `TASK-NNN` separados por comas.
- **Trazabilidad SDD:** cita `plan §x.y.z` y los IDs exactos de la spec (`RF-M4-04`, `EC-M4-01`, `RNF-10`, `RN-06`).
- **Archivos en Alcance:** una ruta entre backticks por viñeta, relativa a la raíz. Solo se admiten globs en `packages/db/prisma/migrations/`.
- **Criterios de Verificación:** las líneas `` Comando: `…` `` son comandos que el Gate B ejecuta y que deben terminar con 0.

Un archivo es de test si coincide con `**/*.test.ts`, `**/*.test.tsx`, `**/*.spec.ts`, `**/test/**` o `e2e/**`. Las fases se marcan con encabezados `### Fase N — <nombre>` y definen la rama (§5).

---

## 7. Arranque

- La skill, los subagentes, los hooks y `tools/sdd/` se construyen en una sesión dedicada **antes de TASK-001**, fuera de `tasks.md`, porque el pipeline no puede construirse a sí mismo. Esa sesión también agrega `.claude/run/` a `.gitignore`.
- Hasta que existan el monorepo y sus scripts, `gate.mjs` y `pre-push.mjs` saltan con aviso los controles cuya herramienta todavía no está instalada (typecheck, lint, dependency-cruiser, Vitest).
- Durante el arranque, `core.hooksPath` se configura a mano. Desde la Fase 0, lo hace el script `prepare` del `package.json` raíz.
