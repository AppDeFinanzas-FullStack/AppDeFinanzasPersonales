// Pruebas de la coordinación entre personas (protocolo §5.2). Uso: node --test tools/sdd/test/
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ASSIGNMENTS, nextStep, parseAssignments } from '../lib/coordination.mjs';
import { allTasks, loadBranchGroups } from '../lib/tasks.mjs';
import { readText } from '../lib/repo.mjs';

const A = 'feature/07-12-a';
const B = 'feature/07-12-b';
const groups = [
  { branch: A, summary: 'web', tasks: ['TASK-068', 'TASK-069', 'TASK-106'] },
  { branch: B, summary: 'backend', tasks: ['TASK-096', 'TASK-097'] },
];
const phase = { number: 7, name: 'Fase 7' };
const t = (id, dependencies = [], done = false) => ({ id, title: id, done, dependencies, phase });
// Grafo: 069 ← 068; 097 ← 096; 106 ← 069 y 097 (la web de a necesita el backend de b).
const tasks = [t('TASK-068'), t('TASK-069', ['TASK-068']), t('TASK-096'), t('TASK-097', ['TASK-096']), t('TASK-106', ['TASK-069', 'TASK-097'])];
const closed = (branch, ids) => ({ branch, tasks: tasks.map((x) => ({ ...x, done: ids.includes(x.id) })) });
const assignments = new Map([
  ['TASK-068', 'ana'],
  ['TASK-069', 'ana'],
  ['TASK-096', 'beto'],
  ['TASK-097', 'beto'],
  ['TASK-106', 'ana'],
]);
const step = (member, sources, extra = {}) => nextStep({ member, assignments, groups, tasks, sources, ...extra });

test('asignaciones: filas con IDs sueltos, rangos y listas; el resto del texto se ignora', () => {
  const text = [
    '# Asignaciones',
    '| Tareas | Persona |',
    '| --- | --- |',
    '| TASK-068..TASK-070 | @ana | Fase 7 |',
    '| TASK-071, TASK-073 | beto |',
    'Texto suelto con TASK-099.',
  ].join('\n');
  const owners = parseAssignments(text);
  assert.deepEqual([...owners], [
    ['TASK-068', 'ana'],
    ['TASK-069', 'ana'],
    ['TASK-070', 'ana'],
    ['TASK-071', 'beto'],
    ['TASK-073', 'beto'],
  ]);
  assert.throws(() => parseAssignments('| TASK-068 | @ana |\n| TASK-066..TASK-068 | @beto |'), /TASK-068 está asignada dos veces/);
});

test('coordinación: la primera tarea propia lista se hace en su rama', () => {
  const r = step('ana', [closed(A, []), closed(B, [])]);
  assert.equal(r.action, 'implement');
  assert.equal(r.task, 'TASK-068');
  assert.equal(r.branch, A);
  assert.deepEqual(r.merge, []);
  assert.deepEqual(r.mine, ['TASK-068', 'TASK-069', 'TASK-106']);
});

test('coordinación: espera a la tarea de otra persona y dice de quién es y en qué rama', () => {
  const r = step('ana', [closed(A, ['TASK-068', 'TASK-069']), closed(B, [])]);
  assert.equal(r.action, 'wait');
  assert.deepEqual(r.blocked, [{ task: 'TASK-106', branch: A, waitingOn: [{ task: 'TASK-097', owner: 'beto', branch: B }] }]);
  assert.deepEqual(r.unassigned, []);
});

test('coordinación: una dependencia cerrada en la otra rama de grupo se trae con un merge', () => {
  const r = step('ana', [closed(A, ['TASK-068', 'TASK-069']), closed(B, ['TASK-096', 'TASK-097'])]);
  assert.equal(r.action, 'implement');
  assert.equal(r.task, 'TASK-106');
  assert.deepEqual(r.merge, [B]);
});

test('coordinación: si la rama de la tarea ya tiene la dependencia, no hace falta merge', () => {
  const r = step('ana', [closed(A, ['TASK-068', 'TASK-069', 'TASK-096', 'TASK-097']), closed(B, ['TASK-096', 'TASK-097'])]);
  assert.equal(r.action, 'implement');
  assert.deepEqual(r.merge, []);
});

test('coordinación: una tarea bloqueada no frena a otra propia que ya está lista', () => {
  const own = new Map([...assignments, ['TASK-096', 'ana']]);
  const r = nextStep({ member: 'ana', assignments: own, groups, tasks, sources: [closed(A, ['TASK-068', 'TASK-069']), closed(B, [])] });
  assert.equal(r.action, 'implement');
  assert.equal(r.task, 'TASK-096');
  assert.equal(r.branch, B);
});

test('coordinación: esperar a una tarea sin persona asignada es estar trabado', () => {
  const partial = new Map([...assignments].filter(([id]) => id !== 'TASK-097'));
  const r = nextStep({ member: 'ana', assignments: partial, groups, tasks, sources: [closed(A, ['TASK-068', 'TASK-069']), closed(B, [])] });
  assert.equal(r.action, 'stuck');
  assert.deepEqual(r.unassigned, ['TASK-097']);
});

test('coordinación: una tarea a medio hacer se retoma, y sin tareas abiertas no queda nada', () => {
  const active = { task: 'TASK-069', branch: A, status: 'in_progress' };
  assert.deepEqual(step('ana', [closed(A, [])], { active }), { action: 'resume', member: 'ana', task: 'TASK-069', branch: A, status: 'in_progress' });
  const all = tasks.map((x) => x.id);
  assert.equal(step('ana', [closed(A, all)]).action, 'done');
  assert.equal(step('nadie', [closed(A, [])]).action, 'done');
});

// Que cada tarea abierta tenga persona lo dice `coordinate.mjs status`: depende de lo cerrado en cada rama.
test('las asignaciones reales: cada tarea asignada existe y está en una rama de grupo', () => {
  const owners = parseAssignments(readText(ASSIGNMENTS));
  const real = new Set(allTasks().map((x) => x.id));
  const grouped = new Set(loadBranchGroups().flatMap((g) => g.tasks));
  assert.ok(owners.size > 0);
  for (const id of owners.keys()) {
    assert.ok(real.has(id), `${id} no existe en tasks.md`);
    assert.ok(grouped.has(id), `${id} no está en ninguna rama de grupo`);
  }
});
