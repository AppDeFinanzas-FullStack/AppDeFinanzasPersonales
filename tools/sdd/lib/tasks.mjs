// Lectura de tasks.md con el formato de docs/execution-protocol.md §6.
import { readdirSync, existsSync } from 'node:fs';
import { ROOT, abs, readText } from './repo.mjs';

const TASK_HEADER = /^- \[( |x)\] \*\*`(TASK-\d{3})`: (.*)\*\*\s*$/;
const PHASE_HEADER = /^### Fase (\d+) — (.+)$/;
const SPEC_ID = /\b(RNF-\d{2}|RN-\d{2}|RF-M\d+-\d{2}|EC-M\d+-\d{2})\b/g;
const TASK_ID = /\bTASK-\d{3}\b/g;

/** Carpetas de feature (`NNN-nombre/`) con su tasks.md. */
export function featureDirs() {
  return readdirSync(ROOT, { withFileTypes: true })
    .filter((d) => d.isDirectory() && /^\d{3}-/.test(d.name) && existsSync(abs(`${d.name}/tasks.md`)))
    .map((d) => d.name)
    .sort();
}

export function tasksPath(feature) {
  return `${feature}/tasks.md`;
}

/** Parsea el texto de un tasks.md y devuelve sus tareas en orden. */
export function parseTasks(text, feature = '') {
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  const tasks = [];
  let phase = null;
  let current = null;

  const close = (endLine) => {
    if (!current) return;
    current.raw = lines.slice(current.startLine, endLine).join('\n').trimEnd();
    tasks.push(finishTask(current));
    current = null;
  };

  lines.forEach((line, i) => {
    const ph = line.match(PHASE_HEADER);
    if (ph) {
      close(i);
      phase = { number: Number(ph[1]), name: ph[2].trim() };
      return;
    }
    if (/^#{1,3} /.test(line)) {
      close(i);
      return;
    }
    const th = line.match(TASK_HEADER);
    if (th) {
      close(i);
      current = { feature, done: th[1] === 'x', id: th[2], title: th[3].replace(/`/g, ''), phase, startLine: i, lineIndex: i };
    }
  });
  close(lines.length);
  return tasks;
}

function field(raw, name) {
  const re = new RegExp(`^  - \\*\\*${name}[^*]*:\\*\\*(.*)$`, 'm');
  const m = raw.match(re);
  if (!m) return null;
  // El campo sigue en las líneas con sangría de 4 espacios.
  const start = raw.indexOf(m[0]) + m[0].length;
  const rest = raw.slice(start).split('\n');
  const extra = [];
  for (const l of rest.slice(1)) {
    if (/^ {4}/.test(l)) extra.push(l.trim());
    else break;
  }
  return { inline: m[1].trim(), items: extra };
}

function finishTask(t) {
  const deps = field(t.raw, 'Dependencias');
  const trace = field(t.raw, 'Trazabilidad SDD');
  const scope = field(t.raw, 'Archivos en Alcance');
  const spec = field(t.raw, 'Especificación de Implementación');
  const criteria = field(t.raw, 'Criterios de Verificación');
  if (!deps || !trace || !scope || !spec || !criteria) {
    throw new Error(`${t.id}: le falta alguno de los cinco campos obligatorios.`);
  }
  const traceText = trace.inline;
  const criteriaText = criteria.items.join('\n');
  return {
    feature: t.feature,
    id: t.id,
    title: t.title,
    done: t.done,
    lineIndex: t.lineIndex,
    phase: t.phase,
    dependencies: deps.inline === 'Ninguna' ? [] : [...new Set(deps.inline.match(TASK_ID) ?? [])],
    traceability: traceText,
    specIds: [...new Set(traceText.match(SPEC_ID) ?? [])],
    planSections: [...new Set([...traceText.matchAll(/plan §(\d+(?:\.\d+)*)/g)].map((m) => m[1]))],
    adrs: [...new Set(traceText.match(/\bADR-\d{2}\b/g) ?? [])],
    scope: scope.items.map((s) => s.replace(/^- /, '').trim()).filter(Boolean).map((s) => s.replace(/^`|`$/g, '')),
    implementation: spec.inline,
    criteria: criteriaText,
    commands: [...criteriaText.matchAll(/Comando:\s*`([^`]+)`/g)].map((m) => m[1]),
    scenarios: [...new Set([...`${criteriaText}`.matchAll(/Escenarios? (?:"([^"]+)"|«([^»]+)»)/g)].map((m) => (m[1] ?? m[2]).trim()))],
    raw: t.raw,
  };
}

/** Todas las tareas de todas las features. */
export function allTasks() {
  return featureDirs().flatMap((f) => parseTasks(readText(tasksPath(f)), f));
}

export function findTask(id) {
  const task = allTasks().find((t) => t.id === id);
  if (!task) throw new Error(`No existe ${id} en ningún tasks.md.`);
  return task;
}

/** Slug de la rama de una fase: feature/NN-slug (protocolo §5). */
export function phaseBranch(phase) {
  const slug = phase.name
    .replace(/\(.*?\)/g, '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
  // Hasta 4 palabras, sin conectores al final.
  const words = slug.split('-').slice(0, 4);
  while (words.length > 1 && ['y', 'e', 'de', 'del', 'la', 'el', 'los', 'las'].includes(words.at(-1))) words.pop();
  return `feature/${String(phase.number).padStart(2, '0')}-${words.join('-')}`;
}

export const BRANCH_GROUPS = 'tools/sdd/branch-groups.json';

/** Expande "TASK-068..TASK-076" a cada ID del rango; un ID suelto queda igual. */
export function expandTaskRange(entry) {
  const m = entry.match(/^TASK-(\d{3})\.\.TASK-(\d{3})$/);
  if (!m) return [entry];
  const ids = [];
  for (let n = Number(m[1]); n <= Number(m[2]); n++) ids.push(`TASK-${String(n).padStart(3, '0')}`);
  return ids;
}

/** Grupos de ramas de varias fases (protocolo §5.1), con sus tareas expandidas. Sin archivo, ninguno. */
export function loadBranchGroups() {
  if (!existsSync(abs(BRANCH_GROUPS))) return [];
  return JSON.parse(readText(BRANCH_GROUPS)).groups.map((g) => ({ ...g, tasks: g.tasks.flatMap(expandTaskRange) }));
}

/** Rama donde se hace una tarea: la de su grupo, si está en uno, o la de su fase. */
export function taskBranch(task, groups = loadBranchGroups()) {
  return groups.find((g) => g.tasks.includes(task.id))?.branch ?? phaseBranch(task.phase);
}

/** Marca o desmarca una tarea en el texto de tasks.md. */
export function setDone(text, id, done) {
  const re = new RegExp(`^- \\[( |x)\\] \\*\\*\`${id}\``, 'm');
  if (!re.test(text)) throw new Error(`No se encontró la línea de ${id}.`);
  return text.replace(re, `- [${done ? 'x' : ' '}] **\`${id}\``);
}

/** Paquete del workspace al que pertenece una ruta ('' para la raíz del repositorio). */
export function workspaceOf(path) {
  const parts = path.split('/');
  if ((parts[0] === 'apps' || parts[0] === 'packages') && parts.length > 2) return `${parts[0]}/${parts[1]}`;
  if (parts[0] === 'e2e' && parts.length > 1) return 'e2e';
  return '';
}

/**
 * Huecos de alcance que harían fallar los gates sin que la tarea pueda corregirlos (protocolo §6):
 *  - quien toca un package.json reescribe pnpm-lock.yaml al instalar, así que debe tenerlo en alcance;
 *  - ESLint revisa TypeScript con tipos: cada .ts/.tsx debe caer en el tsconfig.json de su paquete,
 *    creado en esta tarea o en una anterior;
 *  - un global-setup de Vitest solo corre si su vitest.config.ts lo registra, así que la tarea que lo crea
 *    también tiene esa configuración en su alcance.
 * `tasks` es la lista completa, en orden, para saber qué tsconfig existen antes de la tarea.
 */
export function scopeProblems(task, tasks) {
  const problems = [];
  if (task.scope.some((p) => p.endsWith('package.json')) && !task.scope.includes('pnpm-lock.yaml')) {
    problems.push('toca un package.json pero no tiene pnpm-lock.yaml en su alcance.');
  }
  for (const setup of task.scope.filter((p) => /\/test\/(?:.*\/)?global-setup\.[cm]?[jt]s$/.test(p))) {
    const config = `${workspaceOf(setup)}/vitest.config.ts`;
    if (!task.scope.includes(config)) problems.push(`crea ${setup}, pero no tiene ${config} en su alcance para registrarlo.`);
  }
  const upToHere = tasks.filter((t) => t.id <= task.id);
  const tsconfigs = new Set(upToHere.flatMap((t) => t.scope.filter((p) => p.endsWith('tsconfig.json')).map(workspaceOf)));
  const uncovered = [...new Set(task.scope.filter((p) => /\.(ts|tsx|mts|cts)$/.test(p)).map(workspaceOf))].filter(
    (w) => !tsconfigs.has(w),
  );
  for (const w of uncovered) {
    problems.push(`tiene archivos TypeScript en ${w || 'la raíz'}, pero ninguna tarea hasta esta crea ${w ? `${w}/` : ''}tsconfig.json.`);
  }
  return problems;
}
