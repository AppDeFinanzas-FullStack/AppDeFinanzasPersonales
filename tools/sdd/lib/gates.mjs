// Controles de los gates (protocolo §4.1). Los usan el hook (gate.mjs) y la autoverificación (check.mjs),
// así un subagente puede correr exactamente lo mismo que lo va a juzgar antes de terminar.
import { readFileSync, existsSync } from 'node:fs';
import { findTask } from './tasks.mjs';
import { isTestFile, isTestCaseFile, matchesScope, outOfScope, testCaseNames, NAME_ID } from './scope.mjs';
import { runTests, typecheck, lint, depcruise, commands } from './runner.mjs';
import { changedFiles, abs, tail, sh } from './repo.mjs';
import { hashFile, lockPath } from './state.mjs';

/** Subagente que hace cada fase. El gate solo juzga al de la fase vigente. */
export const PHASE_AGENT = { tests: 'test-author', implement: 'implementer', audit: 'sdd-auditor' };

/** Paradas válidas de un subagente (protocolo §3.2): no se juzgan, detienen el pipeline. */
const STOP_LINE = /^\s*(NEEDS_CLARIFICATION|SCOPE_CHANGE_REQUEST)\s*:?\s*(.*)$/m;

/** Devuelve la parada con la que terminó el subagente, o null. Solo cuenta si abre su respuesta. */
export function stopLine(message) {
  if (typeof message !== 'string') return null;
  const first = message.trimStart().split('\n')[0] ?? '';
  const m = first.match(STOP_LINE);
  return m ? { kind: m[1], text: m[2].trim() } : null;
}

const failures = (results) =>
  results.filter((r) => r.status === 'failed').map((r) => ({ title: r.name, detail: r.output }));

/** Gate A: pruebas solo en el alcance, con IDs, y en rojo (en verde si la tarea es de verificación). */
export function gateAProblems(state) {
  const problems = [];
  const changes = changedFiles();
  const allowed = state.testFiles;
  const stray = outOfScope(changes, allowed);
  if (stray.length) {
    problems.push({
      title: 'Archivos fuera de lo permitido',
      detail: `En esta etapa solo se pueden escribir los archivos de test del alcance:\n${allowed.map((f) => `- ${f}`).join('\n')}\nRevierte estos cambios:\n${stray.map((f) => `- ${f}`).join('\n')}`,
    });
  }

  const caseFiles = changes.filter((f) => isTestCaseFile(f) && existsSync(abs(f)));
  const names = caseFiles.flatMap((f) => testCaseNames(readFileSync(abs(f), 'utf8')).map((n) => ({ f, n })));
  if (!names.length) problems.push({ title: 'Sin casos de prueba', detail: 'No hay ningún caso `it(...)` o `test(...)` en los archivos de test cambiados.' });
  const unnamed = names.filter(({ n }) => !NAME_ID.test(n));
  if (unnamed.length) {
    problems.push({
      title: 'Casos sin ID',
      detail: `Cada caso debe llevar en su nombre el ID que verifica (RF-, EC-, RN-, RNF- o ${state.task}):\n${unnamed.map(({ f, n }) => `- ${f}: "${n}"`).join('\n')}`,
    });
  }

  // Cada RF y EC citado debe tener un caso con su ID (en esta tarea o en el repositorio).
  const task = findTask(state.task);
  const repoNames = sh('git ls-files').output.split(/\r?\n/).filter((f) => isTestCaseFile(f) && existsSync(abs(f)))
    .flatMap((f) => testCaseNames(readFileSync(abs(f), 'utf8')));
  const allNames = [...repoNames, ...names.map(({ n }) => n)];
  const uncovered = task.specIds.filter((id) => /^(RF|EC)-/.test(id) && !allNames.some((n) => n.includes(id)));
  if (uncovered.length) {
    problems.push({ title: 'IDs de la trazabilidad sin prueba', detail: `Agrega al menos un caso con cada uno de estos IDs en su nombre: ${uncovered.join(', ')}` });
  }

  let skipped = [];
  if (!problems.length) {
    const results = runTests(caseFiles);
    skipped = results.filter((r) => r.status === 'skipped');
    const ran = results.filter((r) => r.name.startsWith('tests '));
    if (state.verificationOnly) {
      problems.push(...failures(results));
    } else {
      problems.push(...failures(results.filter((r) => !r.name.startsWith('tests '))));
      for (const r of ran) {
        if (r.status === 'ok') {
          problems.push({ title: `${r.name}: las pruebas pasan`, detail: 'Las pruebas deben fallar antes de la implementación. Verifican algo que todavía no existe.' });
        } else if (/SyntaxError|Transform failed|Unexpected token|ERROR: Expected|No test files found|No tests found/i.test(r.output)) {
          problems.push({ title: `${r.name}: falla por un error del propio test`, detail: tail(r.output, 30) });
        }
      }
    }
  }
  return { problems, skipped };
}

/** Gate B: alcance, pruebas intactas, tipos, lint, capas, tests y comandos de la tarea. */
export function gateBProblems(state) {
  const problems = [];
  const changes = changedFiles();
  const stray = outOfScope(changes, state.scope);
  if (stray.length) problems.push({ title: 'Archivos fuera del alcance', detail: `Revierte estos cambios:\n${stray.map((f) => `- ${f}`).join('\n')}` });

  const lockFile = lockPath(state.task);
  const lock = existsSync(lockFile) ? JSON.parse(readFileSync(lockFile, 'utf8')) : {};
  const tampered = Object.entries(lock).filter(([f, h]) => hashFile(f) !== h).map(([f]) => f);
  // Los harness que la tarea asigna al implementer (scope.mjs → splitScope) sí se pueden escribir aquí.
  const newTests = changes.filter((f) => isTestFile(f) && !matchesScope(f, state.implFiles) && !(f in lock));
  if (tampered.length || newTests.length) {
    problems.push({
      title: 'Pruebas modificadas',
      detail: `Las pruebas las escribe test-author y no se tocan en esta etapa. Restaura:\n${[...tampered, ...newTests].map((f) => `- ${f}`).join('\n')}`,
    });
  }

  let skipped = [];
  if (!problems.length) {
    const impl = changes.filter((f) => !isTestFile(f));
    const results = [
      ...typecheck(changes),
      ...lint(changes),
      ...depcruise(changes),
      ...runTests(Object.keys(lock).filter(isTestCaseFile), { related: impl }),
      ...commands(state.commands),
    ];
    skipped = results.filter((r) => r.status === 'skipped');
    problems.push(...failures(results));
  }
  return { problems, skipped };
}
