// Pruebas de tools/sdd. Uso: node --test tools/sdd/test/
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseTasks, phaseBranch, setDone, allTasks, scopeProblems, workspaceOf } from '../lib/tasks.mjs';
import { isTestFile, isTestCaseFile, matchesScope, outOfScope, testCaseNames, NAME_ID, splitScope } from '../lib/scope.mjs';
import { planSection, dedupeSections, specItem, scenario, adrRow, isUiTask } from '../lib/context.mjs';
import { readText, sh, posixShell } from '../lib/repo.mjs';
import { saveState, loadState, updateState, isCurrent, bumpEpoch } from '../lib/state.mjs';
import { wrapText, SECRETS, MAX_LINE } from '../lib/message.mjs';
import { stopLine, PHASE_AGENT } from '../lib/gates.mjs';
import { buildBrief, availableTasks, MAX_AVAILABLE } from '../lib/brief.mjs';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const SAMPLE = `# Tareas

### Fase 3 — M4 Cuentas (V1.0)

- [x] **\`TASK-001\`: Crear \`algo\`**
  - **Dependencias:** Ninguna
  - **Trazabilidad SDD:** plan §4.4.2, plan §4.4, ADR-03; RF-M4-01, EC-M4-02, RN-06
  - **Archivos en Alcance:**
    - \`apps/api/src/a.ts\`
    - \`apps/api/test/http/a.test.ts\`
    - \`packages/db/prisma/migrations/0001_*/migration.sql\`
  - **Especificación de Implementación:** Hace algo.
  - **Criterios de Verificación (Tests & DoD):**
    - Escenario "Ajuste de saldo": se crea un ajuste.
    - Escenario «Sin "Más" en escritorio».
    - Comando: \`pnpm --filter api build\`

- [ ] **\`TASK-002\`: Otra**
  - **Dependencias:** Requiere TASK-001
  - **Trazabilidad SDD:** plan §2
  - **Archivos en Alcance:**
    - \`e2e/a.spec.ts\`
  - **Especificación de Implementación:** Otra cosa.
  - **Criterios de Verificación (Tests & DoD):**
    - Pasa.
`;

test('parsea las tareas y sus campos', () => {
  const [a, b] = parseTasks(SAMPLE, '001-x');
  assert.equal(a.id, 'TASK-001');
  assert.equal(a.title, 'Crear algo');
  assert.equal(a.done, true);
  assert.deepEqual(a.phase, { number: 3, name: 'M4 Cuentas (V1.0)' });
  assert.deepEqual(a.dependencies, []);
  assert.deepEqual(a.specIds, ['RF-M4-01', 'EC-M4-02', 'RN-06']);
  assert.deepEqual(a.planSections, ['4.4.2', '4.4']);
  assert.deepEqual(a.adrs, ['ADR-03']);
  assert.equal(a.scope.length, 3);
  assert.deepEqual(a.commands, ['pnpm --filter api build']);
  assert.deepEqual(a.scenarios, ['Ajuste de saldo', 'Sin "Más" en escritorio']);
  assert.deepEqual(b.dependencies, ['TASK-001']);
  assert.equal(b.done, false);
});

test('marca y desmarca una tarea', () => {
  const text = setDone(SAMPLE, 'TASK-002', true);
  assert.equal(parseTasks(text)[1].done, true);
  assert.equal(parseTasks(setDone(text, 'TASK-002', false))[1].done, false);
});

test('el tasks.md real tiene 247 tareas válidas y numeradas en orden', () => {
  const tasks = allTasks();
  assert.equal(tasks.length, 247);
  tasks.forEach((t, i) => assert.equal(t.id, `TASK-${String(i + 1).padStart(3, '0')}`));
  for (const t of tasks) {
    assert.ok(t.scope.length > 0, `${t.id} sin alcance`);
    for (const d of t.dependencies) assert.ok(d < t.id, `${t.id} depende de una tarea posterior: ${d}`);
  }
});

test('rama de la fase', () => {
  assert.equal(phaseBranch({ number: 11, name: 'M6 Transacciones (V1.0)' }), 'feature/11-m6-transacciones');
  assert.equal(phaseBranch({ number: 0, name: 'Cimientos, configuración e infraestructura base' }), 'feature/00-cimientos-configuracion-e-infraestructura');
});

test('archivos de test según el protocolo', () => {
  assert.ok(isTestFile('apps/api/test/http/a.test.ts'));
  assert.ok(isTestFile('packages/domain/test/money.test.ts'));
  assert.ok(isTestFile('e2e/playwright.config.ts'));
  assert.ok(isTestFile('apps/web/src/x.test.tsx'));
  assert.ok(!isTestFile('apps/api/src/application/services/a.service.ts'));
  assert.ok(isTestCaseFile('e2e/m1.spec.ts'));
  assert.ok(!isTestCaseFile('e2e/fixtures/auth.ts'));
});

test('alcance exacto y con glob en migraciones', () => {
  const scope = ['apps/api/src/a.ts', 'packages/db/prisma/migrations/*_base/migration.sql'];
  assert.ok(matchesScope('apps/api/src/a.ts', scope));
  assert.ok(matchesScope('packages/db/prisma/migrations/0001_base/migration.sql', scope));
  assert.ok(!matchesScope('apps/api/src/b.ts', scope));
  assert.deepEqual(outOfScope(['apps/api/src/a.ts', 'x.ts'], scope), ['x.ts']);
});

test('nombres de casos y sus IDs', () => {
  const src = `
    describe('grupo', () => {
      it('RF-M6-14 dos POST dejan una fila', async () => {});
      test("EC-M3-02 sin tasa", () => {});
      it.each([[1], [2]])('RN-06 redondea %s', () => {});
      test.describe('no es un caso', () => {});
      it(\`TASK-121 plantilla\`, () => {});
      it('sin id', () => {});
    });`;
  const names = testCaseNames(src);
  assert.deepEqual(names, ['RF-M6-14 dos POST dejan una fila', 'EC-M3-02 sin tasa', 'RN-06 redondea %s', 'TASK-121 plantilla', 'sin id']);
  assert.deepEqual(names.map((n) => NAME_ID.test(n)), [true, true, true, true, false]);
});

test('extrae secciones del plan, reglas y escenarios de la spec', () => {
  const plan = readText('001-appFinanzas-mvp/plan.md');
  const spec = readText('001-appFinanzas-mvp/spec.md');
  const s = planSection(plan, '4.6.2');
  assert.match(s, /^#### 4\.6\.2 Endpoints/);
  assert.ok(!s.includes('#### 4.6.3'));
  assert.ok(planSection(plan, '4.6').includes('#### 4.6.4'));
  assert.deepEqual(dedupeSections(['4.6.2', '4.6', '1.3']), ['4.6', '1.3']);
  assert.match(adrRow(plan, 'ADR-03'), /^\| ADR-03 \| Dinero/);
  const rf = specItem(spec, 'RF-M3-04');
  assert.match(rf, /RF-M3-04/);
  assert.match(rf, /el paralelo, cada hora/);
  assert.ok(!rf.includes('RF-M3-05'));
  assert.match(specItem(spec, 'RN-02'), /Intereses/);
  assert.match(scenario(spec, 'Doble toque no duplica'), /se crea un solo movimiento/);
  assert.equal(specItem(spec, 'RF-M99-01'), null);
});

const baseState = () => ({
  task: 'TASK-002',
  startedAt: '2026-10-17T21:22:19.780Z',
  phase: 'implement',
  status: 'running',
  epoch: 3,
  gates: { A: { attempts: 0, passed: false }, B: { attempts: 0, passed: false } },
});

test('estado vigente: misma tarea, fase, época y en curso', () => {
  const seen = baseState();
  assert.equal(isCurrent(seen, baseState()), true);
  assert.equal(isCurrent(seen, null), false);
  assert.equal(isCurrent(seen, { ...baseState(), phase: 'audit' }), false);
  assert.equal(isCurrent(seen, { ...baseState(), status: 'blocked' }), false);
  assert.equal(isCurrent(seen, { ...baseState(), task: 'TASK-003' }), false);
  assert.equal(isCurrent(seen, { ...baseState(), startedAt: 'otra' }), false);
  const roundTrip = baseState();
  bumpEpoch(roundTrip); // implement → audit → implement vuelve a la misma fase, pero en otra época
  assert.equal(isCurrent(seen, roundTrip), false);
  // Un estado anterior a la época cuenta como época 0.
  const { epoch: _a, ...legacy } = baseState();
  assert.equal(isCurrent(legacy, { ...legacy }), true);
});

test('un gate tardío no pisa el cambio de fase que ocurrió mientras corría', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sdd-state-'));
  const file = join(dir, 'active-task.json');
  try {
    saveState(baseState(), file);
    const seenByGate = loadState(file);

    // Mientras el gate corre, el orquestador pasa a audit y guarda la huella.
    const moved = loadState(file);
    moved.phase = 'audit';
    moved.auditFingerprint = 'abc';
    bumpEpoch(moved);
    saveState(moved, file);

    const result = updateState(seenByGate, (s) => {
      s.gates.B.passed = true;
    }, file);
    assert.equal(result, null);
    const now = loadState(file);
    assert.equal(now.phase, 'audit');
    assert.equal(now.auditFingerprint, 'abc');
    assert.equal(now.gates.B.passed, false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('un gate vigente guarda sobre el estado más reciente sin perder otros campos', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sdd-state-'));
  const file = join(dir, 'active-task.json');
  try {
    saveState(baseState(), file);
    const seenByGate = loadState(file);

    // Otro gate de la misma fase falló entretanto: su intento no se pierde.
    const other = loadState(file);
    other.gates.B.attempts = 1;
    saveState(other, file);

    const saved = updateState(seenByGate, (s) => {
      s.gates.B.attempts += 1;
    }, file);
    assert.equal(saved.gates.B.attempts, 2);
    assert.equal(loadState(file).gates.B.attempts, 2);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('el harness sin casos de prueba lo escribe el implementer', () => {
  const harnessOnly = ['packages/db/package.json', 'packages/db/test/global-setup.ts', 'packages/db/test/helpers.ts'];
  assert.deepEqual(splitScope(harnessOnly), { testFiles: [], implFiles: harnessOnly });
  const withCases = ['e2e/package.json', 'e2e/fixtures/base.ts', 'e2e/smoke.spec.ts', 'pnpm-lock.yaml'];
  assert.deepEqual(splitScope(withCases), {
    testFiles: ['e2e/fixtures/base.ts', 'e2e/smoke.spec.ts'],
    implFiles: ['e2e/package.json', 'pnpm-lock.yaml'],
  });
  const e2eHarness = ['e2e/tsconfig.json', 'e2e/playwright.config.ts', 'e2e/support/axe.ts', 'e2e/smoke.spec.ts'];
  assert.deepEqual(splitScope(e2eHarness).testFiles, ['e2e/support/axe.ts', 'e2e/smoke.spec.ts']);
});

test('huecos de alcance: lockfile y tsconfig del paquete', () => {
  const t = (id, scope) => ({ id, scope });
  const tasks = [
    t('TASK-001', ['packages/db/tsconfig.json', 'packages/db/package.json', 'pnpm-lock.yaml']),
    t('TASK-002', ['packages/db/package.json', 'packages/db/scripts/a.ts']),
    t('TASK-003', ['e2e/smoke.spec.ts']),
    t('TASK-004', ['e2e/tsconfig.json', 'e2e/a.spec.ts']),
    t('TASK-005', ['commitlint.config.cjs', 'apps/web/postcss.config.js']),
  ];
  assert.deepEqual(scopeProblems(tasks[0], tasks), []);
  assert.deepEqual(scopeProblems(tasks[1], tasks), ['toca un package.json pero no tiene pnpm-lock.yaml en su alcance.']);
  assert.match(scopeProblems(tasks[2], tasks)[0], /e2e.*e2e\/tsconfig\.json/);
  assert.deepEqual(scopeProblems(tasks[3], tasks), []);
  assert.deepEqual(scopeProblems(tasks[4], tasks), []); // el JS de configuración se revisa sin tipos
  assert.equal(workspaceOf('apps/web/src/a.tsx'), 'apps/web');
  assert.equal(workspaceOf('eslint.config.js'), '');
});

test('huecos de alcance: un global-setup de Vitest exige el vitest.config.ts de su paquete', () => {
  const t = (id, scope) => ({ id, scope });
  const tasks = [
    t('TASK-001', ['apps/api/tsconfig.json', 'apps/api/test/integration/setup/global-setup.ts']),
    t('TASK-002', ['apps/api/vitest.config.ts', 'apps/api/test/integration/setup/global-setup.ts']),
  ];
  assert.deepEqual(scopeProblems(tasks[0], tasks), [
    'crea apps/api/test/integration/setup/global-setup.ts, pero no tiene apps/api/vitest.config.ts en su alcance para registrarlo.',
  ]);
  assert.deepEqual(scopeProblems(tasks[1], tasks), []);
});

test('gate: paradas válidas y subagente de cada fase', () => {
  assert.deepEqual(stopLine('NEEDS_CLARIFICATION: ¿se redondea antes o después?'), { kind: 'NEEDS_CLARIFICATION', text: '¿se redondea antes o después?' });
  assert.deepEqual(stopLine('\nSCOPE_CHANGE_REQUEST: apps/api/vitest.config.ts · registrar el globalSetup'), {
    kind: 'SCOPE_CHANGE_REQUEST',
    text: 'apps/api/vitest.config.ts · registrar el globalSetup',
  });
  // Solo cuenta si abre la respuesta: una mención en medio del informe no es una parada.
  assert.equal(stopLine('TESTS_READY\nNo hizo falta ningún SCOPE_CHANGE_REQUEST.'), null);
  assert.equal(stopLine(undefined), null);
  assert.deepEqual(PHASE_AGENT, { tests: 'test-author', implement: 'implementer', audit: 'sdd-auditor' });
});

test('ninguna tarea abierta del tasks.md real tiene huecos de alcance', () => {
  const tasks = allTasks();
  const gaps = tasks.filter((t) => !t.done).flatMap((t) => scopeProblems(t, tasks).map((p) => `${t.id} ${p}`));
  assert.deepEqual(gaps, []);
});

test('los comandos de tasks.md corren en un shell POSIX, no en cmd.exe', () => {
  const shell = posixShell();
  assert.ok(shell, 'no se encontró un shell POSIX');
  // cmd.exe pasaría '"a b" ' (con comillas y espacio final) al pipe.
  assert.equal(sh('echo "a b" | cat', { shell }).output, 'a b\n');
});

test('isUiTask: solo el código visual de apps/web cuenta como interfaz', () => {
  assert.equal(isUiTask(['apps/web/src/features/home/HomePage.tsx']), true);
  assert.equal(isUiTask(['apps/web/src/index.css']), true);
  assert.equal(isUiTask(['apps/web/tailwind.config.ts']), true);
  assert.equal(isUiTask(['apps/web/src/features/home/HomePage.test.tsx']), false);
  assert.equal(isUiTask(['apps/web/src/lib/api-client.ts']), false);
  assert.equal(isUiTask(['apps/api/src/routes/home.ts', 'packages/db/seed/preset-categories.ts']), false);
});

test('wrapText corta el cuerpo del commit sin pasar de 100 columnas', () => {
  const long = Array.from({ length: 40 }, (_, i) => `palabra${i}`).join(' ');
  const wrapped = wrapText(`${long}\n\nTask: TASK-001`);
  assert.ok(wrapped.split('\n').every((l) => l.length <= MAX_LINE));
  assert.equal(wrapped.replace(/\n(?!\n|Task)/g, ' '), `${long}\n\nTask: TASK-001`);
  assert.equal(wrapText('corta'), 'corta');
});

test('secretos: una URL con contraseña literal se detecta y un placeholder ${…} no', () => {
  const dbUrl = SECRETS.find(([, label]) => label.includes('base de datos'))[0];
  // Se arma en tiempo de ejecución para que el propio pre-push no la tome como un secreto en el diff.
  const literal = ['DATABASE_URL=postgresql://app:', 'Sup3rS3cret', '@ep-cool.neon.tech/finanzas'].join('');
  assert.equal(dbUrl.test(literal), true);
  assert.equal(dbUrl.test('throw new Error(`connection to postgres://user:${secret}@db failed`)'), false);
  assert.equal(dbUrl.test('postgresql://ci:ci-ephemeral@localhost:5432/finanzas_test'), false);
});

test('resumen de SessionStart: sin tarea activa, avance y tareas disponibles', () => {
  const phase = { number: 4, name: 'Base del API' };
  const t = (id, done, dependencies = []) => ({ id, done, dependencies, phase });
  const tasks = [t('TASK-001', true), t('TASK-002', false, ['TASK-001']), t('TASK-003', false, ['TASK-002']), t('TASK-004', false)];
  const text = buildBrief({ tasks, state: null, branch: 'feature/04-base-del-api', clean: true });
  assert.match(text, /Rama: feature\/04-base-del-api \(árbol limpio\)/);
  assert.match(text, /Tarea activa: ninguna/);
  assert.match(text, /Avance: 1\/4 tareas cerradas \(25 %\)/);
  assert.match(text, /Fase 4 — Base del API: 1\/4/);
  // TASK-003 depende de una tarea abierta: no está disponible.
  assert.match(text, /disponibles \(dependencias cerradas\): TASK-002 \(Fase 4\), TASK-004 \(Fase 4\)\./);
});

test('resumen de SessionStart: tarea bloqueada con su motivo y límite de disponibles', () => {
  const phase = { number: 5, name: 'Base de la web y harness E2E' };
  const tasks = Array.from({ length: 8 }, (_, i) => ({ id: `TASK-${String(i + 1).padStart(3, '0')}`, done: false, dependencies: [], phase }));
  const state = { task: 'TASK-001', title: 'i18n', phase: 'implement', status: 'blocked', blockedReason: 'Gate B falló 4 veces.' };
  const text = buildBrief({ tasks, state, branch: null, clean: null });
  assert.match(text, /Tarea activa: TASK-001 — i18n \(etapa implement, blocked\)\./);
  assert.match(text, /Motivo del bloqueo: Gate B falló 4 veces\./);
  assert.ok(text.includes(`TASK-005 (Fase 5) y ${8 - MAX_AVAILABLE} más.`));
  assert.ok(!text.includes('TASK-006 (Fase 5)'));
  assert.doesNotMatch(text, /Rama:/);
  assert.deepEqual(availableTasks([{ id: 'TASK-001', done: true, dependencies: [] }]), []);
});
