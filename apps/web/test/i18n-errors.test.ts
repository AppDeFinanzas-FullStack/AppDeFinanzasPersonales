import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { ErrorCode, type ErrorCodeName } from '@finanzas/contracts';
import { describe, expect, it } from 'vitest';

import '../src/app/providers/i18n';
import { messageForError } from '../src/lib/i18n-errors';

type ApiErrorArg = Parameters<typeof messageForError>[0];

const ERRORS_JSON = fileURLToPath(new URL('../src/locales/es-BO/errors.json', import.meta.url));
const CODES = Object.keys(ErrorCode) as ErrorCodeName[];
const PLACEHOLDER = /\{\{\s*([\w.]+)\s*(?:,[^}]*)?\}\}/g;

function loadErrorTexts(): Record<string, unknown> {
  return JSON.parse(readFileSync(ERRORS_JSON, 'utf8')) as Record<string, unknown>;
}

function apiError(code: string, data?: Record<string, unknown>): ApiErrorArg {
  const status = (ErrorCode as Record<string, number>)[code] ?? 500;
  return { code, status, data, traceId: 'trace-0001' } as unknown as ApiErrorArg;
}

describe('errors.json (es-BO)', () => {
  it('RNF-07 cada código de ErrorCode tiene su texto en errors.json', () => {
    const texts = loadErrorTexts();
    const missing = CODES.filter((code) => {
      const text = texts[code];
      return typeof text !== 'string' || text.trim() === '';
    });
    expect(missing).toEqual([]);
  });

  it('RNF-07 los textos de errors.json no son el propio código sin traducir', () => {
    const texts = loadErrorTexts();
    const untranslated = CODES.filter((code) => texts[code] === code);
    expect(untranslated).toEqual([]);
  });
});

describe('messageForError', () => {
  it('RNF-07 cada código conocido muestra su texto de errors.json', () => {
    const texts = loadErrorTexts();
    for (const code of CODES) {
      const text = texts[code] as string;
      if (/\{\{/.test(text)) continue;
      expect(messageForError(apiError(code)), code).toBe(text);
    }
  });

  it('RNF-07 messageForError usa data como parámetros del texto', () => {
    const texts = loadErrorTexts();
    for (const code of CODES) {
      const text = texts[code] as string;
      const params = [...text.matchAll(PLACEHOLDER)].map((m) => m[1] as string);
      if (!params.length) continue;
      const data: Record<string, unknown> = {};
      for (const [i, name] of params.entries()) {
        const value = `VALOR${i}X${code}`;
        const parts = name.split('.');
        let target = data;
        for (const part of parts.slice(0, -1)) {
          target[part] ??= {};
          target = target[part] as Record<string, unknown>;
        }
        target[parts[parts.length - 1] as string] = value;
      }
      const message = messageForError(apiError(code, data));
      for (const i of params.keys()) expect(message, code).toContain(`VALOR${i}X${code}`);
      expect(message, code).not.toMatch(/\{\{/);
    }
  });

  it('RNF-17 un código desconocido muestra el texto genérico', () => {
    const first = messageForError(apiError('SOMETHING_NOBODY_DEFINED'));
    const second = messageForError(apiError('ANOTHER_UNKNOWN_CODE'));
    expect(typeof first).toBe('string');
    expect(first.trim()).not.toBe('');
    expect(second).toBe(first);
  });

  it('RNF-17 el texto genérico no muestra detalles internos (código, data ni traceId)', () => {
    const secret = 'secreto-interno-42';
    const message = messageForError({
      code: 'DB_CONNECTION_REFUSED',
      status: 500,
      data: { stack: `Error: ${secret}\n    at db.ts:10`, detail: secret },
      traceId: 'trace-abc-123',
    } as unknown as ApiErrorArg);
    expect(message).not.toContain('DB_CONNECTION_REFUSED');
    expect(message).not.toContain(secret);
    expect(message).not.toContain('db.ts');
    expect(message).not.toContain('trace-abc-123');
    expect(message).not.toMatch(/\{\{/);
  });

  it('RNF-17 el texto genérico no es la clave sin traducir', () => {
    const generic = messageForError(apiError('UNKNOWN_CODE_FOR_TEST'));
    expect(generic).not.toBe('UNKNOWN_CODE_FOR_TEST');
    expect(generic).not.toMatch(/errors[.:]/);
  });
});
