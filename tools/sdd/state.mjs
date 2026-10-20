#!/usr/bin/env node
// Único punto de cambio del estado de la tarea activa. El orquestador nunca edita el JSON a mano.
//   node tools/sdd/state.mjs show
//   node tools/sdd/state.mjs phase <tests|implement|audit|commit>
//   node tools/sdd/state.mjs block "<motivo>"
//   node tools/sdd/state.mjs unblock
//   node tools/sdd/state.mjs abort        (abandona la tarea activa; no toca los archivos)
import { loadState, saveState, clearState, bumpEpoch, verdicts, worktreeFingerprint, MAX_AUDIT_ROUNDS } from './lib/state.mjs';
import { findTask } from './lib/tasks.mjs';
import { buildContext } from './lib/context.mjs';
import { fail, printJson } from './lib/repo.mjs';

const [cmd, arg] = process.argv.slice(2);
const state = loadState();
if (!state) fail('No hay ninguna tarea activa. Empieza con: node tools/sdd/preflight.mjs TASK-NNN');

const lastVerdict = () => verdicts(state.task).at(-1)?.verdict ?? null;

function toPhase(next) {
  if (state.status === 'blocked') fail(`${state.task} está bloqueada: ${state.blockedReason} Resuélvelo y usa "unblock".`);
  const from = state.phase;
  const err = (why) => fail(`No se puede pasar de "${from}" a "${next}": ${why}`);

  switch (next) {
    case 'tests':
      // Reapertura: solo si el Gate B aún no pasó, por un defecto de las propias pruebas (p. ej. lint), que
      // el implementer no puede corregir porque están bloqueadas. Reinicia ambos gates.
      if (from === 'implement' && !state.gates.B.passed) {
        state.gates = { A: { attempts: 0, passed: false }, B: { attempts: 0, passed: false } };
        break;
      }
      if (from !== 'preflight') err('las pruebas se escriben al empezar la tarea.');
      if (!state.testFiles.length) err('la tarea no tiene archivos de test.');
      break;
    case 'implement':
      if (state.verificationOnly) err('es una tarea de verificación: no tiene etapa de implementación.');
      if (from === 'preflight' && state.testFiles.length) err('primero hay que escribir las pruebas (fase tests).');
      if (from === 'tests' && !state.gates.A.passed) err('el Gate A todavía no pasó.');
      if (from === 'audit') {
        // NEEDS_CLARIFICATION cuenta una vez resuelta en un commit docs: (spec, plan o tasks.md).
        if (!['CHANGES_REQUIRED', 'NEEDS_CLARIFICATION'].includes(lastVerdict())) err('el último veredicto no es CHANGES_REQUIRED ni NEEDS_CLARIFICATION.');
        if (state.auditRounds + 1 > MAX_AUDIT_ROUNDS) {
          err(`se agotaron las ${MAX_AUDIT_ROUNDS} rondas de corrección. Bloquea la tarea y consulta al usuario.`);
        }
        state.auditRounds += 1;
        state.gates.B = { attempts: 0, passed: false };
      }
      if (!['preflight', 'tests', 'audit'].includes(from)) err('transición inválida.');
      break;
    case 'audit':
      if (from === 'implement' && !state.gates.B.passed) err('el Gate B todavía no pasó.');
      else if (from === 'tests' && !(state.verificationOnly && state.gates.A.passed)) err('solo una tarea de verificación con el Gate A aprobado pasa directo a auditoría.');
      else if (!['implement', 'tests'].includes(from)) err('transición inválida.');
      state.auditFingerprint = worktreeFingerprint();
      break;
    case 'commit':
      if (from !== 'audit') err('solo se cierra después de la auditoría.');
      if (lastVerdict() !== 'APPROVED') err('la auditoría no está aprobada.');
      break;
    default:
      fail('Fase inválida. Usa tests, implement, audit o commit.');
  }

  state.phase = next;
  bumpEpoch(state);
  saveState(state);
  if (next === 'implement' && from === 'audit') buildContext(findTask(state.task), { round: state.auditRounds });
  printJson({ task: state.task, phase: state.phase, auditRounds: state.auditRounds });
}

switch (cmd) {
  case 'show':
    printJson({ ...state, lastVerdict: lastVerdict() });
    break;
  case 'phase':
    toPhase(arg);
    break;
  case 'block':
    if (!arg) fail('Indica el motivo: state.mjs block "<motivo>"');
    state.status = 'blocked';
    state.blockedReason = arg;
    bumpEpoch(state);
    saveState(state);
    printJson({ task: state.task, status: 'blocked', blockedReason: arg });
    break;
  case 'unblock': {
    state.status = 'running';
    state.blockedReason = null;
    if (state.phase === 'tests') state.gates.A.attempts = 0;
    if (state.phase === 'implement') state.gates.B.attempts = 0;
    bumpEpoch(state);
    saveState(state);
    printJson({ task: state.task, status: 'running', phase: state.phase });
    break;
  }
  case 'abort':
    clearState();
    printJson({ task: state.task, aborted: true, note: 'Los archivos modificados quedan como están; revísalos con git status.' });
    break;
  default:
    fail('Uso: state.mjs show | phase <fase> | block "<motivo>" | unblock | abort');
}
