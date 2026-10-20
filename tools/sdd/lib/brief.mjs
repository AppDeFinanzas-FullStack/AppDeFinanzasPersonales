// Resumen del estado del proyecto para el hook SessionStart (protocolo §4.3). Función pura: se prueba sin git.
import { phaseBranch } from './tasks.mjs';

export const MAX_AVAILABLE = 5;

const pct = (done, total) => (total ? Math.round((done / total) * 100) : 0);

/** Tareas abiertas cuyas dependencias están todas cerradas, en orden. */
export function availableTasks(tasks) {
  const done = new Set(tasks.filter((t) => t.done).map((t) => t.id));
  return tasks.filter((t) => !t.done && t.dependencies.every((d) => done.has(d)));
}

/**
 * Arma el texto del resumen. Recibe lo que ya se leyó del repositorio:
 *   tasks  → allTasks(); state → active-task.json o null; branch → rama actual; clean → árbol limpio;
 *   groups → loadBranchGroups().
 * Cualquier dato puede faltar (null): se omite su línea.
 */
export function buildBrief({ tasks = [], state = null, branch = null, clean = null, groups = [] }) {
  const lines = ['Resumen del proyecto al iniciar la sesión (hook SessionStart; solo lectura):'];

  if (branch) lines.push(`- Rama: ${branch}${clean === null ? '' : clean ? ' (árbol limpio)' : ' (con cambios sin commit)'}.`);

  if (state) {
    const title = state.title ? ` — ${state.title}` : '';
    lines.push(`- Tarea activa: ${state.task}${title} (etapa ${state.phase}, ${state.status}).`);
    if (state.status === 'blocked' && state.blockedReason) lines.push(`  Motivo del bloqueo: ${state.blockedReason}`);
  } else {
    lines.push('- Tarea activa: ninguna.');
  }

  if (tasks.length) {
    const done = tasks.filter((t) => t.done).length;
    lines.push(`- Avance: ${done}/${tasks.length} tareas cerradas (${pct(done, tasks.length)} %).`);

    // En una rama de grupo (protocolo §5.1) se muestra el avance del grupo y solo sus tareas disponibles.
    const group = branch ? groups.find((g) => g.branch === branch) : null;
    if (group) {
      const inGroup = tasks.filter((t) => group.tasks.includes(t.id));
      const closed = inGroup.filter((t) => t.done).length;
      lines.push(`- Rama de grupo (${group.summary}): ${closed}/${inGroup.length} tareas cerradas.`);
    } else {
      // Fase de referencia: la de la tarea activa, la de la rama actual o la primera con tareas abiertas.
      const byPhase = (n) => tasks.filter((t) => t.phase?.number === n);
      const active = state ? tasks.find((t) => t.id === state.task) : null;
      const onBranch = branch ? tasks.find((t) => t.phase && phaseBranch(t.phase) === branch) : null;
      const firstOpen = tasks.find((t) => !t.done);
      const ref = (active ?? onBranch ?? firstOpen)?.phase;
      if (ref) {
        const inPhase = byPhase(ref.number);
        const closed = inPhase.filter((t) => t.done).length;
        lines.push(`- Fase ${ref.number} — ${ref.name}: ${closed}/${inPhase.length} tareas cerradas (rama ${phaseBranch(ref)}).`);
      }
    }

    const next = availableTasks(tasks).filter((t) => !group || group.tasks.includes(t.id));
    if (next.length) {
      const shown = next.slice(0, MAX_AVAILABLE).map((t) => `${t.id} (Fase ${t.phase?.number})`).join(', ');
      const more = next.length > MAX_AVAILABLE ? ` y ${next.length - MAX_AVAILABLE} más` : '';
      lines.push(`- Tareas disponibles (dependencias cerradas): ${shown}${more}.`);
    } else {
      lines.push('- Tareas disponibles: ninguna.');
    }
  }

  return lines.join('\n');
}
