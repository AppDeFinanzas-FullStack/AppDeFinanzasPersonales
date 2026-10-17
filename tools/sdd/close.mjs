#!/usr/bin/env node
// Cierre de la tarea activa (protocolo §2.1 paso 4 y §5): marca [x], hace el commit y limpia el estado.
// Uso: node tools/sdd/close.mjs --type feat --scope transactions --summary "texto"
//        [--body "texto"] [--trailer "Clave: valor"]...
import { join } from 'node:path';
import { loadState, clearState, verdicts, taskDir } from './lib/state.mjs';
import { allTasks, setDone, tasksPath } from './lib/tasks.mjs';
import { outOfScope } from './lib/scope.mjs';
import { changedFiles, readText, abs, writeText, git, gitOut, fail, printJson } from './lib/repo.mjs';

const TYPES = ['feat', 'fix', 'test', 'chore', 'build', 'ci', 'refactor', 'perf', 'docs'];

function args() {
  const out = { trailer: [] };
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i += 2) {
    const key = argv[i]?.replace(/^--/, '');
    const value = argv[i + 1];
    if (!key || value === undefined) fail(`Falta el valor de ${argv[i]}.`);
    if (key === 'trailer') out.trailer.push(value);
    else out[key] = value;
  }
  return out;
}

const opts = args();
const state = loadState();
if (!state) fail('No hay ninguna tarea activa.');
if (state.phase !== 'commit') fail(`La tarea está en la fase "${state.phase}". Pasa a "commit" con state.mjs después de la auditoría aprobada.`);
if (verdicts(state.task).at(-1)?.verdict !== 'APPROVED') fail('La última auditoría no está aprobada.');
const gateOk = state.verificationOnly ? state.gates.A.passed : state.gates.B.passed;
if (!gateOk) fail('El gate de la última etapa no está aprobado.');
if (!TYPES.includes(opts.type)) fail(`--type debe ser uno de: ${TYPES.join(', ')}.`);
if (!opts.scope || !/^[a-z0-9-]+$/.test(opts.scope)) fail('--scope es obligatorio (minúsculas, números y guiones).');
if (!opts.summary) fail('--summary es obligatorio.');

const header = `${opts.type}(${opts.scope}): ${state.task} ${opts.summary}`;
if (header.length > 100) fail(`El encabezado del commit tiene ${header.length} caracteres (máximo 100).`);

const changes = changedFiles();
if (!changes.length) fail('No hay cambios para cerrar.');
const stray = outOfScope(changes, state.scope);
if (stray.length) fail(`Hay cambios fuera del alcance:\n  ${stray.join('\n  ')}`);

const tasksFile = tasksPath(state.feature);
const original = readText(tasksFile);
writeText(abs(tasksFile), setDone(original, state.task, true));

const message = [
  header,
  '',
  opts.body ?? '',
  '',
  `Task: ${state.task}`,
  'Audit: approved',
  ...opts.trailer,
].join('\n').replace(/\n{3,}/g, '\n\n');
const msgFile = join(taskDir(state.task), 'commit-msg.txt');
writeText(msgFile, `${message}\n`);

const add = git(`add -A -- ${[...changes, tasksFile].map((f) => `"${f}"`).join(' ')}`);
const commit = add.code === 0 ? git(`commit -F "${msgFile}"`) : add;
if (commit.code !== 0) {
  writeText(abs(tasksFile), original);
  git(`reset -q -- ${[...changes, tasksFile].map((f) => `"${f}"`).join(' ')}`);
  fail(`El commit falló y se revirtió la marca en tasks.md:\n${commit.output}`);
}

const hash = gitOut('rev-parse --short HEAD');
const tasks = allTasks();
const phaseNumber = tasks.find((t) => t.id === state.task).phase.number;
const remaining = tasks
  .filter((t) => t.feature === state.feature && t.phase.number === phaseNumber && !t.done)
  .map((t) => t.id);
clearState();

printJson({
  task: state.task,
  commit: hash,
  header,
  branch: state.branch,
  lastOfPhase: remaining.length === 0,
  remainingInPhase: remaining,
});
