// Mensajes de commit y secretos: lo comparten close.mjs y pre-push.mjs.

export const MAX_LINE = 100;

export const CONVENTIONAL = /^(feat|fix|docs|test|chore|build|ci|refactor|perf|style|revert)(\([\w\-./]+\))?!?: \S.*$/;

// Una contraseña escrita como `${…}` es un placeholder de código, no un secreto literal.
export const SECRETS = [
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----/, 'clave privada'],
  [/\bre_[A-Za-z0-9_]{20,}\b/, 'API key de Resend'],
  [/\bsk-ant-[A-Za-z0-9_-]{20,}/, 'API key de Anthropic'],
  [/\bgh[pousr]_[A-Za-z0-9]{30,}\b/, 'token de GitHub'],
  [/\bAKIA[0-9A-Z]{16}\b/, 'access key de AWS'],
  [/postgres(?:ql)?:\/\/[^:\s/]+:(?!\$\{)[^@\s]+@(?!localhost|127\.0\.0\.1|db[:/]|postgres[:/])[^\s"']+/, 'URL de base de datos con contraseña'],
];

/** Corta cada línea en palabras para que ninguna pase de `width` (commitlint: body-max-line-length). */
export function wrapText(text, width = MAX_LINE) {
  return text
    .split('\n')
    .flatMap((line) => {
      if (line.length <= width) return [line];
      const out = [];
      let current = '';
      for (const word of line.split(' ')) {
        if (current && current.length + 1 + word.length > width) {
          out.push(current);
          current = word;
        } else {
          current = current ? `${current} ${word}` : word;
        }
      }
      if (current) out.push(current);
      return out;
    })
    .join('\n');
}
