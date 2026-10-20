// Estado de la tarea activa: .claude/run/active-task.json y .claude/run/TASK-XXX/.
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, rmSync, appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { RUN_DIR, ROOT, abs, writeText, changedFiles, gitOut } from './repo.mjs';
import { splitScope } from './scope.mjs';

export const STATE_FILE = join(RUN_DIR, 'active-task.json');
export const MAX_GATE_ATTEMPTS = 3;
export const MAX_AUDIT_ROUNDS = 2;

export function taskDir(id) {
  return join(RUN_DIR, id);
}

export function loadState(file = STATE_FILE) {
  if (!existsSync(file)) return null;
  return JSON.parse(readFileSync(file, 'utf8'));
}

export function saveState(state, file = STATE_FILE) {
  state.updatedAt = new Date().toISOString();
  writeText(file, `${JSON.stringify(state, null, 2)}\n`);
}

/** Cambia de "época": cada cambio de fase, bloqueo o desbloqueo invalida los gates que ya estaban corriendo. */
export function bumpEpoch(state) {
  state.epoch = (state.epoch ?? 0) + 1;
}

/** ¿Sigue vigente el estado que un proceso leyó al empezar (`seen`) frente al actual (`fresh`)? */
export function isCurrent(seen, fresh) {
  return (
    Boolean(fresh) &&
    fresh.task === seen.task &&
    fresh.startedAt === seen.startedAt &&
    fresh.phase === seen.phase &&
    (fresh.epoch ?? 0) === (seen.epoch ?? 0) &&
    fresh.status === 'running'
  );
}

/**
 * Relee el estado y le aplica `mutate` solo si sigue vigente respecto de `seen`.
 * Así un proceso largo (el gate) no pisa un cambio de fase que ocurrió mientras corría.
 * Devuelve el estado guardado, o null si el resultado quedó obsoleto y se descartó.
 */
export function updateState(seen, mutate, file = STATE_FILE) {
  const fresh = loadState(file);
  if (!isCurrent(seen, fresh)) return null;
  mutate(fresh);
  saveState(fresh, file);
  return fresh;
}

export function clearState() {
  rmSync(STATE_FILE, { force: true });
}

export function newState(task, branch) {
  const { testFiles, implFiles } = splitScope(task.scope);
  return {
    task: task.id,
    feature: task.feature,
    title: task.title,
    branch,
    phase: 'preflight',
    status: 'running',
    blockedReason: null,
    scope: task.scope,
    testFiles,
    implFiles,
    commands: task.commands,
    verificationOnly: testFiles.length > 0 && testFiles.length === task.scope.length,
    gates: { A: { attempts: 0, passed: false }, B: { attempts: 0, passed: false } },
    auditRounds: 0,
    auditFingerprint: null,
    epoch: 0,
    startedAt: new Date().toISOString(),
  };
}

export function log(id, title, body) {
  mkdirSync(taskDir(id), { recursive: true });
  appendFileSync(join(taskDir(id), 'gate.log'), `\n===== ${new Date().toISOString()} · ${title} =====\n${body}\n`);
}

/** Hash de los archivos de test, para tests.lock. */
export function hashFile(rel) {
  const path = abs(rel);
  if (!existsSync(path)) return null;
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

export function lockPath(id) {
  return join(taskDir(id), 'tests.lock');
}

/** Huella del árbol de trabajo: detecta si alguien escribió durante la auditoría. */
export function worktreeFingerprint() {
  const h = createHash('sha256');
  h.update(gitOut('diff HEAD --binary'));
  for (const f of changedFiles()) {
    h.update(f);
    const path = abs(f);
    if (existsSync(path)) h.update(readFileSync(path));
  }
  return h.digest('hex');
}

/** Anota que `check.mjs` verificó el árbol con esta huella en esta época; el gate no lo repite. */
export function markChecked(state, fingerprint) {
  state.checked = { epoch: state.epoch ?? 0, fingerprint };
}

/** ¿El árbol de trabajo es exactamente el que `check.mjs` ya verificó en esta época? */
export function wasChecked(state, fingerprint) {
  return Boolean(state.checked) && state.checked.epoch === (state.epoch ?? 0) && state.checked.fingerprint === fingerprint;
}

/** Veredictos registrados en audit.md, en orden. */
export function verdicts(id) {
  const file = join(taskDir(id), 'audit.md');
  if (!existsSync(file)) return [];
  return [...readFileSync(file, 'utf8').matchAll(/^## Ronda (\d+) — (APPROVED|CHANGES_REQUIRED|NEEDS_CLARIFICATION)$/gm)].map((m) => ({
    round: Number(m[1]),
    verdict: m[2],
  }));
}

/** Texto de la última auditoría con cambios pedidos (para la siguiente ronda del implementador). */
export function lastFindings(id) {
  const file = join(taskDir(id), 'audit.md');
  if (!existsSync(file)) return null;
  const parts = readFileSync(file, 'utf8').split(/^(?=## Ronda )/m);
  const last = parts.reverse().find((p) => p.includes('— CHANGES_REQUIRED'));
  return last ? last.trim() : null;
}

export { ROOT };
