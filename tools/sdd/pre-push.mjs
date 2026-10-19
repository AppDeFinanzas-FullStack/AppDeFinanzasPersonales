#!/usr/bin/env node
// Hook de git pre-push (protocolo §4.2). Git pasa por stdin una línea por referencia:
//   <ref local> <sha local> <ref remota> <sha remota>
// Revisa los commits que se van a subir y rechaza el push si alguno no cumple.
import { readFileSync, existsSync } from 'node:fs';
import { git, gitOut, sh, abs, tail } from './lib/repo.mjs';
import { parseTasks } from './lib/tasks.mjs';
import { isTestCaseFile, testCaseNames } from './lib/scope.mjs';
import { rootScript, ensureDatabase, packageJson } from './lib/runner.mjs';
import { CONVENTIONAL, MAX_LINE, SECRETS } from './lib/message.mjs';

const ZERO = /^0+$/;
const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';

const input = process.stdin.isTTY ? '' : readFileSync(0, 'utf8');
const refs = input.split(/\r?\n/).filter(Boolean).map((l) => l.split(' '));
const problems = [];
const warnings = [];
const add = (title, detail) => problems.push(`✖ ${title}\n${detail}`);

for (const [, localSha, remoteRef, remoteSha] of refs) {
  if (ZERO.test(localSha)) continue; // borrado de una rama remota
  const range = ZERO.test(remoteSha) ? `${localSha} --not --remotes` : `${remoteSha}..${localSha}`;
  const commits = gitOut(`rev-list --reverse ${range}`).split('\n').filter(Boolean);
  if (!commits.length) continue;
  // Base del diff: la remota, o el padre del primer commit nuevo; si es la raíz del repo, el árbol vacío.
  const parent = ZERO.test(remoteSha) ? `${commits[0]}~1` : remoteSha;
  const realBase = git(`rev-parse --verify --quiet ${parent}`).code === 0;
  const base = realBase ? parent : EMPTY_TREE;

  // 1. Conventional Commits. Los merges (traer develop a la rama) los escribe git y commitlint los ignora.
  for (const c of commits) {
    if (gitOut(`log -1 --format=%P ${c}`).split(' ').length > 1) continue;
    const subject = gitOut(`log -1 --format=%s ${c}`);
    if (!CONVENTIONAL.test(subject) || subject.length > MAX_LINE) add(`Mensaje inválido en ${c.slice(0, 7)}`, `"${subject}" no sigue Conventional Commits (máximo ${MAX_LINE} caracteres).`);
  }
  const commitlint = existsSync(abs('node_modules/.bin/commitlint')) || existsSync(abs('node_modules/.bin/commitlint.cmd'));
  if (commitlint && realBase) {
    const cl = sh(`pnpm exec commitlint --from ${base} --to ${localSha}`);
    if (cl.code !== 0) add('commitlint', tail(cl.output, 30));
  }

  // 2. Secretos en las líneas agregadas y archivos .env.
  const names = gitOut(`diff --name-only --diff-filter=AM ${base} ${localSha}`).split('\n').filter(Boolean);
  const envFiles = names.filter((f) => /(^|\/)\.env(\.|$)/.test(f) && !f.endsWith('.env.example'));
  if (envFiles.length) add('Archivos .env', envFiles.join('\n'));
  const added = gitOut(`diff -U0 --no-color ${base} ${localSha}`).split('\n').filter((l) => l.startsWith('+') && !l.startsWith('+++'));
  for (const [re, label] of SECRETS) {
    const hit = added.find((l) => re.test(l));
    if (hit) add(`Posible secreto (${label})`, hit.slice(0, 160));
  }

  // 3. Trazabilidad y 4. cobertura de IDs.
  const closed = [];
  for (const c of commits) {
    const body = gitOut(`log -1 --format=%B ${c}`);
    const task = body.match(/^Task:\s*(TASK-\d{3})\s*$/m)?.[1];
    if (!task) continue;
    if (!/^Audit:\s*approved\s*$/m.test(body)) add(`${c.slice(0, 7)} (${task}) sin "Audit: approved"`, 'Las tareas solo se cierran con la auditoría aprobada.');
    const files = gitOut(`ls-tree -r --name-only ${localSha}`).split('\n').filter((f) => /^\d{3}-[^/]+\/tasks\.md$/.test(f));
    const found = files.flatMap((f) => parseTasks(gitOut(`show ${localSha}:${f}`), f.split('/')[0])).find((t) => t.id === task);
    if (!found) add(`${task} no existe`, `El commit ${c.slice(0, 7)} referencia una tarea que no está en ningún tasks.md.`);
    else if (!found.done) add(`${task} sin cerrar`, `El commit ${c.slice(0, 7)} la referencia, pero no está en [x] en tasks.md.`);
    else closed.push(found);
  }
  if (closed.length) {
    const testNames = gitOut(`ls-tree -r --name-only ${localSha}`).split('\n').filter(isTestCaseFile)
      .flatMap((f) => testCaseNames(gitOut(`show ${localSha}:"${f}"`)));
    const ids = [...new Set(closed.flatMap((t) => t.specIds.filter((id) => /^(RF|EC)-/.test(id))))];
    const missing = ids.filter((id) => !testNames.some((n) => n.includes(id)));
    if (missing.length) add('RF y EC sin test con su ID en el nombre', missing.join(', '));
  }

  // 5. Suite completa, salvo que el push sea solo de documentación.
  const onlyDocs = names.length > 0 && names.every((f) => /^docs\/|^\d{3}-[^/]+\/[^/]+\.md$|\.md$/.test(f));
  if (!onlyDocs && !problems.length) {
    if (packageJson('')?.scripts?.['test:integration']) {
      const db = ensureDatabase();
      if (db.status === 'failed') add(db.name, tail(db.output, 20));
    }
    for (const script of ['lint', 'typecheck', 'depcruise', 'test:unit', 'test:integration']) {
      const r = rootScript(script);
      if (r.status === 'failed') add(r.name, tail(r.output, 40));
      if (r.status === 'skipped') warnings.push(`${r.name}: ${r.output}`);
    }
  }
  if (remoteRef) warnings.unshift(`Revisado ${remoteRef}: ${commits.length} commit(s).`);
}

for (const w of warnings) process.stderr.write(`• ${w}\n`);
if (problems.length) {
  process.stderr.write(`\nPush rechazado por el pre-push (docs/execution-protocol.md §4.2):\n\n${problems.join('\n\n')}\n`);
  process.exit(1);
}
process.stderr.write('✓ pre-push: todo en orden.\n');
