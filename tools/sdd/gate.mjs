#!/usr/bin/env node
// Hook SubagentStop (protocolo §4.1). Lee la fase de la tarea activa y aplica su gate:
//   tests     → Gate A: pruebas solo en el alcance, con IDs, en rojo (o en verde si es de verificación).
//   implement → Gate B: alcance, pruebas intactas, tipos, lint, capas, tests y comandos.
//   audit     → verifica que el auditor no modificó nada.
// Si un control falla, bloquea el cierre del subagente y le devuelve el motivo (máximo 3 veces).
// Los controles tardan: antes de guardar se relee el estado, y si la fase cambió mientras corrían
// (por ejemplo, el orquestador ya pasó a audit) el resultado se descarta en lugar de pisar el estado.
import { readFileSync, existsSync } from 'node:fs';
import { loadState, updateState, log, hashFile, lockPath, worktreeFingerprint, MAX_GATE_ATTEMPTS } from './lib/state.mjs';
import { findTask } from './lib/tasks.mjs';
import { isTestFile, isTestCaseFile, matchesScope, outOfScope, testCaseNames, NAME_ID } from './lib/scope.mjs';
import { runTests, typecheck, lint, depcruise, commands } from './lib/runner.mjs';
import { changedFiles, abs, writeText, tail, sh } from './lib/repo.mjs';

// La entrada del hook (JSON por stdin) no se necesita: todo sale de active-task.json.
if (!process.stdin.isTTY) {
  try {
    readFileSync(0);
  } catch {
    /* sin stdin */
  }
}

const state = loadState();
if (!state || state.status !== 'running') process.exit(0);

const respond = (obj) => {
  process.stdout.write(JSON.stringify(obj));
  process.exit(0);
};

/** Guarda en el estado vigente; si quedó obsoleto, registra el descarte y deja terminar al subagente. */
function commit(what, mutate) {
  const saved = updateState(state, mutate);
  if (saved) return saved;
  log(state.task, `${what} descartado`, `La tarea cambió de fase o de estado mientras corría (fase al empezar: "${state.phase}"). El resultado ya no aplica y no se guardó.`);
  process.exit(0);
}

function finish(gateKey, problems, onPass) {
  const name = `Gate ${gateKey}`;
  if (!problems.length) {
    commit(name, (s) => {
      s.gates[gateKey].passed = true;
    });
    onPass?.();
    log(state.task, `${name} ✓`, 'Todos los controles pasaron.');
    process.exit(0);
  }
  const saved = commit(name, (s) => {
    const gate = s.gates[gateKey];
    gate.attempts += 1;
    gate.passed = false;
    if (gate.attempts > MAX_GATE_ATTEMPTS) {
      s.status = 'blocked';
      s.blockedReason = `${name} falló ${MAX_GATE_ATTEMPTS + 1} veces. Detalle en .claude/run/${s.task}/gate.log.`;
    }
  });
  const gate = saved.gates[gateKey];
  const full = problems.map((p) => `### ${p.title}\n${p.detail}`).join('\n\n');
  log(state.task, `${name} ✗ (intento ${gate.attempts}/${MAX_GATE_ATTEMPTS})`, full);
  if (saved.status === 'blocked') respond({ systemMessage: `${state.task}: ${saved.blockedReason}` });
  const short = problems.map((p) => `### ${p.title}\n${tail(p.detail, 40)}`).join('\n\n');
  respond({
    decision: 'block',
    reason:
      `${name} no pasó (intento ${gate.attempts} de ${MAX_GATE_ATTEMPTS}). Corrige esto antes de terminar, ` +
      `sin salir del alcance${gateKey === 'B' ? ' y sin modificar las pruebas' : ''}:\n\n${short}`,
  });
}

const failures = (results) =>
  results.filter((r) => r.status === 'failed').map((r) => ({ title: r.name, detail: r.output }));

function skipped(results) {
  const s = results.filter((r) => r.status === 'skipped');
  if (s.length) log(state.task, 'Controles saltados', s.map((r) => `- ${r.name}: ${r.output}`).join('\n'));
}

// ---------- Gate A ----------
function gateA() {
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

  if (!problems.length) {
    const results = runTests(caseFiles);
    skipped(results);
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

  finish('A', problems, () => {
    const lock = Object.fromEntries(state.testFiles.filter((f) => existsSync(abs(f))).map((f) => [f, hashFile(f)]));
    writeText(lockPath(state.task), `${JSON.stringify(lock, null, 2)}\n`);
  });
}

// ---------- Gate B ----------
function gateB() {
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

  if (!problems.length) {
    const impl = changes.filter((f) => !isTestFile(f));
    const results = [
      ...typecheck(changes),
      ...lint(changes),
      ...depcruise(changes),
      ...runTests(Object.keys(lock).filter(isTestCaseFile), { related: impl }),
      ...commands(state.commands),
    ];
    skipped(results);
    problems.push(...failures(results));
  }
  finish('B', problems);
}

// ---------- Auditoría ----------
function auditCheck() {
  if (state.auditFingerprint && worktreeFingerprint() !== state.auditFingerprint) {
    const reason = 'El árbol de trabajo cambió durante la auditoría; el auditor no debe escribir.';
    commit('Control de auditoría', (s) => {
      s.status = 'blocked';
      s.blockedReason = reason;
    });
    log(state.task, 'Auditoría ✗', reason);
    respond({ systemMessage: `${state.task}: ${reason}` });
  }
  process.exit(0);
}

try {
  if (state.phase === 'tests') gateA();
  else if (state.phase === 'implement') gateB();
  else if (state.phase === 'audit') auditCheck();
  else process.exit(0);
} catch (e) {
  // Un error del propio gate no es culpa del subagente: se deja terminar y la tarea queda bloqueada.
  log(state.task, 'Error interno del gate', e.stack ?? String(e));
  const reason = `Error interno del gate: ${e.message}`;
  commit('Error interno del gate', (s) => {
    s.status = 'blocked';
    s.blockedReason = reason;
  });
  respond({ systemMessage: `${state.task}: ${reason}` });
}
