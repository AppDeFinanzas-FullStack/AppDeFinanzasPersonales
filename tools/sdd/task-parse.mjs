#!/usr/bin/env node
// Uso: node tools/sdd/task-parse.mjs TASK-NNN  → imprime la tarea como JSON.
import { findTask } from './lib/tasks.mjs';
import { fail, printJson } from './lib/repo.mjs';

const id = process.argv[2];
if (!/^TASK-\d{3}$/.test(id ?? '')) fail('Uso: node tools/sdd/task-parse.mjs TASK-NNN');
try {
  const { raw, ...task } = findTask(id);
  printJson(task);
} catch (e) {
  fail(e.message);
}
