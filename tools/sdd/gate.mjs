#!/usr/bin/env node
// Hook SubagentStop (protocolo §4.1). Lee la fase de la tarea activa y aplica su gate:
//   tests     → Gate A: pruebas solo en el alcance, con IDs, en rojo (o en verde si es de verificación).
//   implement → Gate B: alcance, pruebas intactas, tipos, lint, capas, tests y comandos.
//   audit     → verifica que el auditor no modificó nada.
// Si un control falla, bloquea el cierre del subagente y le devuelve el motivo (máximo 3 veces).
// Solo juzga al subagente de la fase vigente (agent_type), y una parada válida (NEEDS_CLARIFICATION o
// SCOPE_CHANGE_REQUEST, protocolo §3.2) no gasta intentos: detiene el pipeline para preguntarle al usuario.
// Los controles tardan: antes de guardar se relee el estado, y si la fase cambió mientras corrían
// (por ejemplo, el orquestador ya pasó a audit) el resultado se descarta en lugar de pisar el estado.
import { readFileSync, existsSync } from 'node:fs';
import { loadState, updateState, log, hashFile, lockPath, worktreeFingerprint, MAX_GATE_ATTEMPTS } from './lib/state.mjs';
import { PHASE_AGENT, stopLine, gateAProblems, gateBProblems } from './lib/gates.mjs';
import { abs, writeText, tail } from './lib/repo.mjs';

// Entrada del hook (JSON por stdin): agent_type y last_assistant_message. Si falta, se juzga igual.
let input = {};
if (!process.stdin.isTTY) {
  try {
    input = JSON.parse(readFileSync(0, 'utf8') || '{}');
  } catch {
    input = {};
  }
}

const state = loadState();
if (!state || state.status !== 'running') process.exit(0);

// Otro subagente (por ejemplo, uno de exploración) no es el de esta fase: no se juzga.
const expected = PHASE_AGENT[state.phase];
if (input.agent_type && expected && input.agent_type !== expected) process.exit(0);

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

// Parada válida: no es una falla del subagente. Se bloquea la tarea y el orquestador le pregunta al usuario.
const stop = state.phase === 'tests' || state.phase === 'implement' ? stopLine(input.last_assistant_message) : null;
if (stop) {
  const reason = `${stop.kind}: ${stop.text || 'ver la respuesta del subagente'}`;
  commit('Parada del subagente', (s) => {
    s.status = 'blocked';
    s.blockedReason = reason;
  });
  log(state.task, `Parada (${stop.kind})`, reason);
  respond({ systemMessage: `${state.task}: ${reason}` });
}

function finish(gateKey, { problems, skipped }, onPass) {
  const name = `Gate ${gateKey}`;
  if (skipped.length) log(state.task, 'Controles saltados', skipped.map((r) => `- ${r.name}: ${r.output}`).join('\n'));
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
      `sin salir del alcance${gateKey === 'B' ? ' y sin modificar las pruebas' : ''}. ` +
      `Comprueba con \`node tools/sdd/check.mjs\` antes de volver a terminar:\n\n${short}`,
  });
}

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
  if (state.phase === 'tests') {
    finish('A', gateAProblems(state), () => {
      const lock = Object.fromEntries(state.testFiles.filter((f) => existsSync(abs(f))).map((f) => [f, hashFile(f)]));
      writeText(lockPath(state.task), `${JSON.stringify(lock, null, 2)}\n`);
    });
  } else if (state.phase === 'implement') finish('B', gateBProblems(state));
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
