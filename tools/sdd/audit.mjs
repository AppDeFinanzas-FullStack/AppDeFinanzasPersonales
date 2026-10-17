#!/usr/bin/env node
// Uso: node tools/sdd/audit.mjs record <archivo-con-la-respuesta-del-auditor>
// Valida el formato del veredicto (protocolo §3.1) y lo agrega a .claude/run/TASK-NNN/audit.md.
import { readFileSync, existsSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadState, saveState, taskDir, verdicts } from './lib/state.mjs';
import { fail, printJson } from './lib/repo.mjs';

const [cmd, file] = process.argv.slice(2);
if (cmd !== 'record' || !file) fail('Uso: node tools/sdd/audit.mjs record <archivo>');
if (!existsSync(file)) fail(`No existe ${file}.`);

const state = loadState();
if (!state) fail('No hay ninguna tarea activa.');
if (state.phase !== 'audit') fail(`La tarea está en la fase "${state.phase}", no en "audit".`);

const text = readFileSync(file, 'utf8').replace(/\r\n/g, '\n').trim();
const m = text.match(/^\s*VERDICT:\s*(APPROVED|CHANGES_REQUIRED|NEEDS_CLARIFICATION)\b/);
if (!m) fail('La respuesta del auditor no empieza con "VERDICT: APPROVED | CHANGES_REQUIRED | NEEDS_CLARIFICATION".');
const verdict = m[1];
if (verdict === 'CHANGES_REQUIRED' && !/\S+:\d+\s*·/.test(text)) {
  fail('CHANGES_REQUIRED sin hallazgos con el formato "archivo:línea · regla · corrección".');
}

const round = verdicts(state.task).length + 1;
appendFileSync(join(taskDir(state.task), 'audit.md'), `## Ronda ${round} — ${verdict}\n\n${text}\n\n`);

if (verdict === 'NEEDS_CLARIFICATION') {
  state.status = 'blocked';
  state.blockedReason = 'La auditoría pide una aclaración de negocio (ver audit.md).';
  saveState(state);
}
printJson({ task: state.task, round, verdict, status: state.status });
