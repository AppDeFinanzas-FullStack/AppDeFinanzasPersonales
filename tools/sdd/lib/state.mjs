// Estado de la tarea activa: .claude/run/active-task.json y .claude/run/TASK-XXX/.
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, rmSync, appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { RUN_DIR, ROOT, abs, writeText, changedFiles, gitOut } from './repo.mjs';
import { isTestFile } from './scope.mjs';

export const STATE_FILE = join(RUN_DIR, 'active-task.json');
export const MAX_GATE_ATTEMPTS = 3;
export const MAX_AUDIT_ROUNDS = 2;

export function taskDir(id) {
  return join(RUN_DIR, id);
}

export function loadState() {
  if (!existsSync(STATE_FILE)) return null;
  return JSON.parse(readFileSync(STATE_FILE, 'utf8'));
}

export function saveState(state) {
  state.updatedAt = new Date().toISOString();
  writeText(STATE_FILE, `${JSON.stringify(state, null, 2)}\n`);
}

export function clearState() {
  rmSync(STATE_FILE, { force: true });
}

export function newState(task, branch) {
  const testFiles = task.scope.filter((p) => isTestFile(p));
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
    implFiles: task.scope.filter((p) => !isTestFile(p)),
    commands: task.commands,
    verificationOnly: testFiles.length > 0 && testFiles.length === task.scope.length,
    gates: { A: { attempts: 0, passed: false }, B: { attempts: 0, passed: false } },
    auditRounds: 0,
    auditFingerprint: null,
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
