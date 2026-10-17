// Ejecución de verificaciones por workspace. Si una herramienta todavía no está instalada,
// el control se salta con aviso (docs/execution-protocol.md §7).
import { existsSync, readFileSync } from 'node:fs';
import { posix } from 'node:path';
import { abs, sh, exists } from './repo.mjs';

/** Resultado de un control: ok, skipped (con motivo) o falla con salida. */
const ok = (name, output = '') => ({ name, status: 'ok', output });
const skip = (name, reason) => ({ name, status: 'skipped', output: reason });
const bad = (name, output) => ({ name, status: 'failed', output });

const depsInstalled = () => existsSync(abs('node_modules'));

/** Workspace (carpeta con package.json, distinta de la raíz) que contiene un archivo. */
export function workspaceOf(path) {
  let dir = posix.dirname(path);
  while (dir && dir !== '.') {
    if (exists(`${dir}/package.json`)) return dir;
    dir = posix.dirname(dir);
  }
  return null;
}

export function packageJson(dir) {
  const file = abs(dir ? `${dir}/package.json` : 'package.json');
  return existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : null;
}

function relTo(dir, path) {
  return posix.relative(dir, path);
}

function quote(p) {
  return `"${p}"`;
}

/** Agrupa archivos por workspace. */
function byWorkspace(files) {
  const groups = new Map();
  for (const f of files) {
    const ws = workspaceOf(f);
    if (!ws) continue;
    if (!groups.has(ws)) groups.set(ws, []);
    groups.get(ws).push(f);
  }
  return groups;
}

export function needsDatabase(files) {
  return files.some((f) => /\/integration\/|\/http\/|^packages\/db\/test\/|^e2e\//.test(f));
}

export function ensureDatabase() {
  if (!exists('docker-compose.yml')) return skip('base de datos', 'no existe docker-compose.yml');
  const r = sh('docker compose up -d --wait db', { timeoutMs: 5 * 60_000 });
  return r.code === 0 ? ok('base de datos') : bad('base de datos (docker compose up -d --wait db)', r.output);
}

/**
 * Corre los archivos de test indicados. Devuelve un resultado por workspace.
 * `related`: además corre `vitest related` sobre los archivos de implementación.
 */
export function runTests(testFiles, { related = [] } = {}) {
  const results = [];
  if (!depsInstalled()) return [skip('tests', 'las dependencias no están instaladas (pnpm install)')];
  if (needsDatabase(testFiles)) {
    const db = ensureDatabase();
    results.push(db);
    if (db.status === 'failed') return results;
  }
  for (const [ws, files] of byWorkspace(testFiles)) {
    const pkg = packageJson(ws);
    const rels = files.filter((f) => existsSync(abs(f))).map((f) => quote(relTo(ws, f)));
    if (!rels.length) continue;
    const cmd = ws === 'e2e'
      ? `pnpm --filter ${quote(pkg.name)} exec playwright test ${rels.join(' ')} --project=chromium-1280`
      : `pnpm --filter ${quote(pkg.name)} exec vitest run ${rels.join(' ')}`;
    const r = sh(cmd);
    results.push(r.code === 0 ? ok(`tests ${ws}`, r.output) : bad(`tests ${ws}`, `$ ${cmd}\n${r.output}`));
  }
  for (const [ws, files] of byWorkspace(related)) {
    if (ws === 'e2e') continue;
    const pkg = packageJson(ws);
    const rels = files.filter((f) => existsSync(abs(f)) && /\.(ts|tsx|js|mjs)$/.test(f)).map((f) => quote(relTo(ws, f)));
    const hasVitest = pkg?.devDependencies?.vitest || pkg?.dependencies?.vitest || existsSync(abs(`${ws}/vitest.config.ts`));
    if (!rels.length || !hasVitest) continue;
    const cmd = `pnpm --filter ${quote(pkg.name)} exec vitest related --run --passWithNoTests ${rels.join(' ')}`;
    const r = sh(cmd);
    results.push(r.code === 0 ? ok(`tests relacionados ${ws}`) : bad(`tests relacionados ${ws}`, `$ ${cmd}\n${r.output}`));
  }
  return results;
}

/** Typecheck de cada workspace tocado. */
export function typecheck(files) {
  if (!depsInstalled()) return [skip('typecheck', 'las dependencias no están instaladas')];
  const results = [];
  for (const ws of byWorkspace(files).keys()) {
    const pkg = packageJson(ws);
    let cmd;
    if (pkg?.scripts?.typecheck) cmd = `pnpm --filter ${quote(pkg.name)} run typecheck`;
    else if (exists(`${ws}/tsconfig.json`)) cmd = `pnpm --filter ${quote(pkg.name)} exec tsc --noEmit -p tsconfig.json`;
    else continue;
    const r = sh(cmd);
    results.push(r.code === 0 ? ok(`typecheck ${ws}`) : bad(`typecheck ${ws}`, `$ ${cmd}\n${r.output}`));
  }
  return results;
}

/** ESLint de los archivos cambiados. */
export function lint(files) {
  const targets = files.filter((f) => /\.(ts|tsx|js|jsx|mjs|cjs)$/.test(f) && existsSync(abs(f)));
  if (!targets.length) return [];
  if (!existsSync(abs('node_modules/.bin/eslint')) && !existsSync(abs('node_modules/.bin/eslint.cmd'))) {
    return [skip('lint', 'ESLint todavía no está instalado')];
  }
  const cmd = `pnpm exec eslint --max-warnings=0 --no-warn-ignored ${targets.map(quote).join(' ')}`;
  const r = sh(cmd);
  return [r.code === 0 ? ok('lint') : bad('lint', `$ ${cmd}\n${r.output}`)];
}

/** Reglas de capas, si se tocó el backend. */
export function depcruise(files) {
  if (!files.some((f) => f.startsWith('apps/api/src/'))) return [];
  const pkg = packageJson('');
  if (!pkg?.scripts?.depcruise || !depsInstalled()) return [skip('dependency-cruiser', 'todavía no está configurado')];
  const r = sh('pnpm run depcruise');
  return [r.code === 0 ? ok('dependency-cruiser') : bad('dependency-cruiser', r.output)];
}

/** Comandos `Comando:` de la tarea. */
export function commands(list) {
  return list.map((cmd) => {
    const r = sh(cmd);
    return r.code === 0 ? ok(`comando: ${cmd}`) : bad(`comando: ${cmd}`, r.output);
  });
}

/** Script raíz de package.json (para la suite completa del pre-push). */
export function rootScript(name) {
  const pkg = packageJson('');
  if (!pkg?.scripts?.[name] || !depsInstalled()) return skip(`pnpm ${name}`, 'el script todavía no existe');
  const r = sh(`pnpm run ${name}`, { timeoutMs: 30 * 60_000 });
  return r.code === 0 ? ok(`pnpm ${name}`) : bad(`pnpm ${name}`, r.output);
}

