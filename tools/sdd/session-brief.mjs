#!/usr/bin/env node
// Hook SessionStart (protocolo §4.3): al abrir Claude en el proyecto, le da un resumen de dónde quedó el
// trabajo (rama, tarea activa, avance y tareas disponibles). Solo lee; nunca bloquea ni rompe la sesión.
import { readFileSync } from 'node:fs';
import { buildBrief } from './lib/brief.mjs';
import { allTasks, loadBranchGroups } from './lib/tasks.mjs';
import { loadState } from './lib/state.mjs';
import { currentBranch, isClean } from './lib/repo.mjs';

const attempt = (fn) => {
  try {
    return fn();
  } catch {
    return null;
  }
};

// La entrada del hook (source: startup, resume, clear, compact) no cambia el resumen.
if (!process.stdin.isTTY) attempt(() => readFileSync(0));

try {
  const text = buildBrief({
    tasks: attempt(allTasks) ?? [],
    state: attempt(() => loadState()),
    branch: attempt(currentBranch),
    clean: attempt(isClean),
    groups: attempt(loadBranchGroups) ?? [],
  });
  process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: text } }));
} catch {
  // Sin resumen antes que una sesión rota.
}
process.exit(0);
