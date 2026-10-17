#!/usr/bin/env node
// Uso: node tools/sdd/preflight.mjs TASK-NNN [--dry-run]
// Valida que la tarea se pueda empezar (o retomar), ubica la rama de su fase,
// arma el paquete de contexto y escribe .claude/run/active-task.json (protocolo §2.1).
import { allTasks, phaseBranch } from './lib/tasks.mjs';
import { buildContext } from './lib/context.mjs';
import { loadState, saveState, newState } from './lib/state.mjs';
import { outOfScope } from './lib/scope.mjs';
import { changedFiles, currentBranch, git, fail, printJson } from './lib/repo.mjs';

const id = process.argv[2];
const dryRun = process.argv.includes('--dry-run');
if (!/^TASK-\d{3}$/.test(id ?? '')) fail('Uso: node tools/sdd/preflight.mjs TASK-NNN [--dry-run]');

const tasks = allTasks();
const task = tasks.find((t) => t.id === id);
if (!task) fail(`No existe ${id} en ningún tasks.md.`);

const state = loadState();
if (state && state.task !== id) {
  fail(`Hay otra tarea activa: ${state.task} (fase ${state.phase}, ${state.status}). Ciérrala o retómala antes de empezar ${id}.`);
}
const resume = state?.task === id;
if (task.done) fail(`${id} ya está cerrada ([x]) en tasks.md.`);

const pending = task.dependencies.filter((d) => !tasks.find((t) => t.id === d)?.done);
if (pending.length) fail(`${id} depende de tareas abiertas: ${pending.join(', ')}.`);

const expected = phaseBranch(task.phase);
const branch = currentBranch();
const changes = changedFiles();

if (resume) {
  const stray = outOfScope(changes, task.scope);
  if (stray.length) fail(`Retomando ${id}, pero hay cambios fuera de su alcance:\n  ${stray.join('\n  ')}`);
  if (branch !== expected) fail(`${id} se retoma en ${expected}, pero estás en ${branch}.`);
} else {
  if (changes.length) fail(`El árbol de trabajo no está limpio:\n  ${changes.join('\n  ')}\nHaz commit o descarta esos cambios antes de empezar.`);
  if (branch === 'develop') {
    if (!dryRun) {
      const exists = git(`rev-parse --verify --quiet refs/heads/${expected}`).code === 0;
      const r = git(exists ? `switch ${expected}` : `switch -c ${expected}`);
      if (r.code !== 0) fail(`No se pudo cambiar a ${expected}:\n${r.output}`);
    }
  } else if (branch !== expected) {
    fail(`${id} pertenece a la fase ${task.phase.number}: debe hacerse en ${expected} (o desde develop). Estás en ${branch}.`);
  }
}

// Al retomar, el alcance y los comandos se releen de tasks.md (pudo corregirse con un SCOPE_CHANGE_REQUEST).
const fresh = newState(task, expected);
const active = resume
  ? { ...state, scope: fresh.scope, testFiles: fresh.testFiles, implFiles: fresh.implFiles, commands: fresh.commands, verificationOnly: fresh.verificationOnly }
  : fresh;
if (!dryRun) {
  saveState(active);
  buildContext(task, { round: active.auditRounds });
}

const steps = [];
if (active.testFiles.length) steps.push('tests');
if (!active.verificationOnly) steps.push('implement');
steps.push('audit', 'commit');

printJson({
  task: id,
  title: task.title,
  phase: `Fase ${task.phase.number} — ${task.phase.name}`,
  branch: expected,
  resume,
  currentPhase: active.phase,
  status: active.status,
  blockedReason: active.blockedReason,
  steps,
  verificationOnly: active.verificationOnly,
  testFiles: active.testFiles,
  implFiles: active.implFiles,
  commands: active.commands,
  context: `.claude/run/${id}/context.md`,
  dryRun,
});
