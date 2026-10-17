// Pruebas de tools/sdd. Uso: node --test tools/sdd/test/
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseTasks, phaseBranch, setDone, allTasks } from '../lib/tasks.mjs';
import { isTestFile, isTestCaseFile, matchesScope, outOfScope, testCaseNames, NAME_ID } from '../lib/scope.mjs';
import { planSection, dedupeSections, specItem, scenario, adrRow } from '../lib/context.mjs';
import { readText } from '../lib/repo.mjs';

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
