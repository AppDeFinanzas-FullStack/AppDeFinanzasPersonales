#!/usr/bin/env node
// Autoverificación (protocolo §4.1): corre los mismos controles que el gate de la fase vigente, pero sin
// gastar intentos ni cambiar el estado. El test-author y el implementer la corren antes de terminar.
// Uso: node tools/sdd/check.mjs   → código 0 si el gate pasaría, 1 si no.
import { loadState } from './lib/state.mjs';
import { gateAProblems, gateBProblems } from './lib/gates.mjs';

const state = loadState();
if (!state) {
  process.stdout.write('No hay ninguna tarea activa.\n');
  process.exit(0);
}

const gate = state.phase === 'tests' ? 'A' : state.phase === 'implement' ? 'B' : null;
if (!gate) {
  process.stdout.write(`${state.task} está en la fase "${state.phase}": no hay gate que verificar.\n`);
  process.exit(0);
}

const { problems, skipped } = gate === 'A' ? gateAProblems(state) : gateBProblems(state);
for (const r of skipped) process.stdout.write(`• ${r.name}: ${r.output}\n`);
if (!problems.length) {
  process.stdout.write(`✓ ${state.task}: el Gate ${gate} pasaría. Ya puedes terminar.\n`);
  process.exit(0);
}
process.stdout.write(
  `✖ ${state.task}: el Gate ${gate} no pasaría todavía. Corrige esto y vuelve a correr el check:\n\n` +
    `${problems.map((p) => `### ${p.title}\n${p.detail}`).join('\n\n')}\n`,
);
process.exit(1);
