// Utilidades de repositorio: raíz, comandos de shell y git.
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
export const RUN_DIR = join(ROOT, '.claude', 'run');

export function abs(rel) {
  return join(ROOT, ...rel.split('/'));
}

export function readText(rel) {
  return readFileSync(abs(rel), 'utf8').replace(/\r\n/g, '\n');
}

export function writeText(file, content) {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, content, 'utf8');
}

export function exists(rel) {
  return existsSync(abs(rel));
}

/**
 * Shell POSIX para los comandos de tasks.md, que se escriben con sintaxis de sh (`echo "x" | …`).
 * En Windows es el bash de Git: nunca cmd.exe (deja las comillas en el echo) ni el bash de WSL.
 * Devuelve null si no lo encuentra.
 */
export function posixShell() {
  if (process.platform !== 'win32') return '/bin/sh';
  const execPath = spawnSync('git', ['--exec-path'], { encoding: 'utf8' }).stdout?.trim();
  const candidates = [
    process.env.CLAUDE_CODE_GIT_BASH_PATH,
    // <git>/mingw64/libexec/git-core → <git>/bin/bash.exe
    execPath && resolve(execPath, '..', '..', '..', 'bin', 'bash.exe'),
    'C:\\Program Files\\Git\\bin\\bash.exe',
  ];
  return candidates.find((p) => p && existsSync(p)) ?? null;
}

/** Ejecuta un comando con shell en la raíz. Nunca lanza: devuelve { code, output }. */
export function sh(command, { cwd = ROOT, timeoutMs = 15 * 60_000, input, shell = true } = {}) {
  const r = spawnSync(command, {
    cwd,
    shell,
    encoding: 'utf8',
    timeout: timeoutMs,
    input,
    maxBuffer: 64 * 1024 * 1024,
    env: { ...process.env, FORCE_COLOR: '0', CI: process.env.CI ?? '1' },
  });
  const output = `${r.stdout ?? ''}${r.stderr ?? ''}`;
  if (r.error) return { code: 1, output: `${output}\n${r.error.message}` };
  return { code: r.status ?? 1, output };
}

export function git(args, opts) {
  return sh(`git ${args}`, opts);
}

export function gitOut(args) {
  const r = git(args);
  if (r.code !== 0) throw new Error(`git ${args} falló:\n${r.output}`);
  return r.output.replace(/\r\n/g, '\n').trimEnd();
}

export function currentBranch() {
  return gitOut('branch --show-current');
}

/** Archivos cambiados respecto de HEAD, incluidos los nuevos sin seguimiento. Rutas con '/'. */
export function changedFiles() {
  const out = gitOut('-c core.quotepath=false status --porcelain=v1 -uall');
  if (!out) return [];
  const files = new Set();
  for (const line of out.split('\n')) {
    if (!line.trim()) continue;
    let path = line.slice(3);
    if (path.includes(' -> ')) {
      const [from, to] = path.split(' -> ');
      files.add(unquote(from));
      path = to;
    }
    files.add(unquote(path));
  }
  return [...files].sort();
}

function unquote(p) {
  return p.startsWith('"') && p.endsWith('"') ? p.slice(1, -1) : p;
}

export function isClean() {
  return changedFiles().length === 0;
}

/** Últimas N líneas de un texto, para mensajes cortos. */
export function tail(text, n = 60) {
  const lines = text.replace(/\r\n/g, '\n').trimEnd().split('\n');
  return lines.length <= n ? lines.join('\n') : `… (${lines.length - n} líneas omitidas)\n${lines.slice(-n).join('\n')}`;
}

export function fail(message) {
  process.stderr.write(`✖ ${message}\n`);
  process.exit(1);
}

export function printJson(value) {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}
