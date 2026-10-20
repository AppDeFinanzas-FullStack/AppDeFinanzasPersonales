---
name: coordinar-fases
description: Trabaja en bucle las tareas asignadas a la persona en docs/asignaciones.md, en las ramas de grupo de las Fases 7 a 12. Hace cada tarea con /implement-task cuando sus dependencias están cerradas en origin, la sube, y si le toca esperar a otra persona espera en segundo plano hasta que esa tarea se suba. Usar cuando el usuario pida coordinar, seguir con sus tareas asignadas o "hacer lo que me toca".
---

# /coordinar-fases — Mis tareas asignadas, en bucle

Haces, una tras otra, las tareas que `docs/asignaciones.md` le asigna a esta persona, cada una en su rama de grupo (protocolo §5.1 y §5.2). Las otras personas hacen lo mismo con su Claude Code: la señal de que una tarea está hecha es que aparece `[x]` en el `tasks.md` de su rama en `origin`. Por eso **subes cada tarea apenas se cierra**.

Las decisiones las toma `node tools/sdd/coordinate.mjs`: nunca adivinas qué te toca ni si una dependencia está lista.

## Reglas que nunca rompes
1. Las tareas se hacen solo con la skill `implement-task`. Tú coordinas: no escribes código, pruebas ni `tasks.md`.
2. Ningún guardarraíl se salta: nada de `--no-verify`, `--force` ni push a `develop`, `qa` o `main`. Solo subes a la rama de grupo de la tarea.
3. Nunca reescribes historia compartida: para traer cambios usas merge (`git pull --no-rebase`), no rebase.
4. Si algo no está en estas instrucciones (un conflicto, un gate que falla, una pregunta de un subagente), te detienes y se lo explicas al usuario. No improvisas.
5. No cambias `docs/asignaciones.md` ni `tools/sdd/branch-groups.json`: el reparto lo decide el equipo.

## Paso 1 — Qué me toca
```
node tools/sdd/coordinate.mjs next
```
Si falla porque no sabe quién eres, dile al usuario que lo configure una vez (`git config sdd.member <usuario-de-github>`) y detente.

Según `action`:
- **`resume`**: hay una tarea a medio hacer en esta copia. Si no estás en su `branch`, cámbiate (`git switch <branch>`). Ve al paso 3 con esa tarea.
- **`implement`**: ve al paso 2.
- **`wait`**: ve al paso 5.
- **`stuck`**: alguna tarea tuya depende de una tarea que no tiene persona (`unassigned`). Díselo al usuario, con las tareas de `blocked`, y detente: hay que asignarla en `docs/asignaciones.md`.
- **`done`**: no te quedan tareas. Muestra `node tools/sdd/coordinate.mjs status` y termina.

## Paso 2 — Preparar la rama
1. El árbol tiene que estar limpio (`git status --porcelain`). Si no lo está, detente y dile al usuario qué archivos hay.
2. Cámbiate a la rama de la tarea:
   - si existe en local: `git switch <branch>`;
   - si solo existe en `origin`: `git switch --track origin/<branch>`.
3. Trae lo que subieron los demás: `git pull --no-rebase --no-edit`.
4. Por cada rama de `merge` (dependencias cerradas en la otra rama de grupo o en `develop`): `git merge --no-edit origin/<rama>`.
5. Si un pull o un merge tiene conflictos: `git merge --abort`, detente y dile al usuario qué archivos chocaron.

## Paso 3 — Hacer la tarea
Invoca la skill `implement-task` con el ID de la tarea y sigue sus instrucciones completas.
- Si el pipeline se detiene (pregunta de un subagente, gate agotado, auditoría sin aprobar), **detente tú también**: el usuario decide. No pases a otra tarea dejando esa bloqueada.
- Cuando `close.mjs` hace el commit, **no** ofrezcas el PR a `develop` aunque responda `lastOfPhase: true`: anótalo para el informe del paso 4.

## Paso 4 — Subir la tarea
1. `git push` (si la rama todavía no sigue a origin: `git push -u origin <branch>`). Corre el hook `pre-push`.
2. Si el push se rechaza porque otra persona subió antes: `git pull --no-rebase --no-edit` y vuelve a intentar, hasta 3 veces. Si hay conflictos o el `pre-push` falla, detente y explícaselo al usuario.
3. Informa en una o dos líneas: tarea, commit y rama. Si `close.mjs` dijo `lastOfPhase: true`, avisa que la rama de grupo está completa y que el PR a `develop` lo abre una persona.
4. Vuelve al paso 1.

## Paso 5 — Esperar
1. Dile al usuario en una línea qué tarea tuya espera y a cuál de quién (`blocked[0].waitingOn`).
2. Lanza la espera **en segundo plano** (Bash con `run_in_background: true`), para no gastar nada mientras tanto:
   ```
   node tools/sdd/coordinate.mjs wait --interval 180
   ```
   Cada 3 minutos hace `git fetch` y vuelve a decidir. Termina sola cuando la acción deja de ser `wait`, y escribe el JSON del paso 1 al final de su salida.
3. Termina el turno. Cuando llegue la notificación de que terminó, lee la salida y sigue en el paso 1 con esa acción (sin volver a correr `next`). Si la acción es `timeout` (pasaron 12 horas), díselo al usuario y detente.
