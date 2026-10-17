// Alcance de archivos y nombres de tests (docs/execution-protocol.md §6).

/** Un archivo es de test si coincide con los patrones del protocolo. */
export function isTestFile(path) {
  return (
    /\.test\.tsx?$/.test(path) ||
    /\.spec\.ts$/.test(path) ||
    /(^|\/)test\//.test(path) ||
    /^e2e\//.test(path)
  );
}

/** Archivos que contienen casos de prueba (los demás de test son harness, fixtures o config). */
export function isTestCaseFile(path) {
  return /\.(test|spec)\.(ts|tsx|mts|js|mjs)$/.test(path);
}

function globToRegex(glob) {
  const re = glob
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*\*/g, '\u0000')
    .replace(/\*/g, '[^/]*')
    .replace(/\u0000/g, '.*');
  return new RegExp(`^${re}$`);
}

export function matchesScope(path, scope) {
  return scope.some((entry) => (entry.includes('*') ? globToRegex(entry).test(path) : entry === path));
}

export function outOfScope(files, scope) {
  return files.filter((f) => !matchesScope(f, scope));
}

const CASE = /\b(?:it|test)(?:\.(?:each|for)\([\s\S]*?\))?(?:\.(?:concurrent|fails))?\s*\(\s*(['"`])((?:\\.|(?!\1)[\s\S])*?)\1/g;
export const NAME_ID = /\b(RNF-\d{2}|RN-\d{2}|RF-M\d+-\d{2}|EC-M\d+-\d{2}|TASK-\d{3})\b/;

/** Nombres de los casos de prueba de un archivo (it/test de Vitest y Playwright). */
export function testCaseNames(source) {
  return [...source.matchAll(CASE)].map((m) => m[2]);
}
