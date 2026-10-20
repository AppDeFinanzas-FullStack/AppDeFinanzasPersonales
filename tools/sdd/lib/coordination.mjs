// Coordinación entre personas en las ramas de grupo (protocolo §5.2). Funciones puras: se prueban sin git.
import { expandTaskRange, taskBranch } from './tasks.mjs';

export const ASSIGNMENTS = 'docs/asignaciones.md';

const ROW = /^\|\s*(TASK-\d{3}(?:\.\.TASK-\d{3})?(?:\s*,\s*TASK-\d{3}(?:\.\.TASK-\d{3})?)*)\s*\|\s*@?([A-Za-z0-9-]+)\s*\|/;

/**
 * Lee la tabla de asignaciones: cada fila `| TASK-068..TASK-070 | @usuario | … |` asigna esas tareas a esa
 * persona (su usuario de GitHub). Las demás líneas se ignoran. Una tarea asignada dos veces es un error.
 * Devuelve un Map TASK-NNN → usuario.
 */
export function parseAssignments(text) {
  const owners = new Map();
  for (const line of text.replace(/\r\n/g, '\n').split('\n')) {
    const m = line.match(ROW);
    if (!m) continue;
    for (const id of m[1].split(',').map((s) => s.trim()).flatMap(expandTaskRange)) {
      if (owners.has(id)) throw new Error(`${id} está asignada dos veces (a ${owners.get(id)} y a ${m[2]}).`);
      owners.set(id, m[2]);
    }
  }
  return owners;
}

/**
 * Qué le toca hacer ahora a una persona. Recibe lo que ya se leyó del repositorio:
 *   member      → usuario de GitHub de quien pregunta;
 *   assignments → parseAssignments(); groups → loadBranchGroups();
 *   tasks       → allTasks() de la copia local (orden, dependencias y fase de cada tarea);
 *   sources     → [{ branch, tasks }] con el tasks.md de cada rama en origin (las de grupo y develop) y el
 *                 de la copia local con su rama: una tarea está cerrada si está [x] en alguna de ellas;
 *   active      → active-task.json o null.
 * Acciones:
 *   resume    → hay una tarea a medio hacer en esta copia: se retoma antes que nada;
 *   implement → la primera tarea propia con todas sus dependencias cerradas, su rama y las ramas que hay que
 *               traer con un merge porque cerraron una dependencia que la rama de la tarea todavía no tiene;
 *   wait      → todas las tareas propias esperan a otras: `blocked` dice cuáles, de quién y en qué rama;
 *   stuck     → alguna tarea propia espera a una tarea sin persona asignada: nadie la va a cerrar;
 *   done      → no le quedan tareas abiertas.
 */
export function nextStep({ member, assignments, groups = [], tasks, sources, active = null }) {
  if (active) return { action: 'resume', member, task: active.task, branch: active.branch ?? null, status: active.status };

  const closedIn = new Map();
  for (const s of sources) {
    for (const t of s.tasks) {
      if (!t.done) continue;
      if (!closedIn.has(t.id)) closedIn.set(t.id, new Set());
      closedIn.get(t.id).add(s.branch);
    }
  }
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const isClosed = (id) => closedIn.has(id);
  const branchOf = (id) => (byId.has(id) ? taskBranch(byId.get(id), groups) : null);

  const mine = tasks.filter((t) => assignments.get(t.id) === member && !isClosed(t.id));
  if (!mine.length) return { action: 'done', member, mine: [] };

  const blocked = [];
  for (const t of mine) {
    const branch = taskBranch(t, groups);
    const waitingOn = t.dependencies
      .filter((d) => !isClosed(d))
      .map((d) => ({ task: d, owner: assignments.get(d) ?? null, branch: branchOf(d) }));
    if (waitingOn.length) {
      blocked.push({ task: t.id, branch, waitingOn });
      continue;
    }
    // Una dependencia cerrada en otra rama se trae con un merge (protocolo §5.1). Se prefiere su rama de
    // grupo; si solo está en develop, se trae develop.
    const merge = new Set();
    for (const d of t.dependencies) {
      const where = closedIn.get(d);
      if (where.has(branch)) continue;
      const own = branchOf(d);
      merge.add(own && where.has(own) ? own : [...where][0]);
    }
    return { action: 'implement', member, task: t.id, title: t.title, branch, merge: [...merge].sort(), mine: mine.map((x) => x.id) };
  }

  const unassigned = [...new Set(blocked.flatMap((b) => b.waitingOn.filter((w) => !w.owner).map((w) => w.task)))];
  const action = blocked.every((b) => b.waitingOn.some((w) => !w.owner)) ? 'stuck' : 'wait';
  return { action, member, blocked, unassigned, mine: mine.map((x) => x.id) };
}
