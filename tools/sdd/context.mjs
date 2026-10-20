#!/usr/bin/env node
// Uso: node tools/sdd/context.mjs TASK-NNN  → (re)genera .claude/run/TASK-NNN/context.md.
import { findTask } from './lib/tasks.mjs';
import { buildContext } from './lib/context.mjs';
import { loadState } from './lib/state.mjs';
import { fail } from './lib/repo.mjs';

const id = process.argv[2];
if (!/^TASK-\d{3}$/.test(id ?? '')) fail('Uso: node tools/sdd/context.mjs TASK-NNN');
try {
  const state = loadState();
  const round = state?.task === id ? state.auditRounds : 0;
  const file = buildContext(findTask(id), { round });
  process.stdout.write(`${file}\n`);
} catch (e) {
  fail(e.message);
}
