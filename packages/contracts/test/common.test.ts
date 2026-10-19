import { describe, expect, it } from 'vitest';

import {
  Amount,
  AmountAbs,
  Cursor,
  CurrencyCode,
  LocalDate,
  Money,
  Note,
  Rate,
  TrimmedName,
  Uuid,
} from '../src/index.js';

const ok = (schema: { safeParse: (v: unknown) => { success: boolean } }, v: unknown) =>
  schema.safeParse(v).success;

describe('Amount (RF-M6-01)', () => {
  it('RF-M6-01 "0.00" es inválido', () => {
    expect(ok(Amount, '0.00')).toBe(false);
  });
  it('RF-M6-01 "1000000000.00" es inválido', () => {
    expect(ok(Amount, '1000000000.00')).toBe(false);
  });
  it('RF-M6-01 "0.01" es válido', () => {
    expect(ok(Amount, '0.01')).toBe(true);
  });
  it('RF-M6-01 "999999999.99" es válido', () => {
    expect(ok(Amount, '999999999.99')).toBe(true);
  });
  it('RF-M6-01 más de 2 decimales es inválido', () => {
    expect(ok(Amount, '1.234')).toBe(false);
  });
  it('RF-M6-01 un monto negativo es inválido', () => {
    expect(ok(Amount, '-5.00')).toBe(false);
  });
  it('RF-M6-01 acepta enteros sin decimales', () => {
    expect(ok(Amount, '10')).toBe(true);
  });
});

describe('Money y AmountAbs (ADR-03)', () => {
  it('TASK-021 ADR-03 Money acepta texto decimal con signo', () => {
    expect(ok(Money, '-1234.56')).toBe(true);
    expect(ok(Money, '1234.56')).toBe(true);
    expect(ok(Money, '0')).toBe(true);
  });
  it('TASK-021 ADR-03 Money rechaza formatos no decimales', () => {
    for (const v of ['abc', '', '1,5', '1.', '.5', '1e3', ' 1.00']) {
      expect(ok(Money, v)).toBe(false);
    }
  });
  it('TASK-021 ADR-03 AmountAbs acepta valores absolutos hasta 999999999.99 con signo', () => {
    expect(ok(AmountAbs, '999999999.99')).toBe(true);
    expect(ok(AmountAbs, '-999999999.99')).toBe(true);
    expect(ok(AmountAbs, '0.00')).toBe(true);
  });
  it('TASK-021 ADR-03 AmountAbs rechaza valores absolutos mayores al máximo', () => {
    expect(ok(AmountAbs, '1000000000.00')).toBe(false);
    expect(ok(AmountAbs, '-1000000000.00')).toBe(false);
  });
  it('TASK-021 ADR-03 ningún schema de monto acepta number', () => {
    for (const schema of [Money, Rate, Amount, AmountAbs]) {
      expect(ok(schema, 10)).toBe(false);
      expect(ok(schema, 0.5)).toBe(false);
      expect(ok(schema, 1234.56)).toBe(false);
    }
  });
});

describe('Rate (RF-M3-02)', () => {
  it('RF-M3-02 "0.009" no es una Rate válida', () => {
    expect(ok(Rate, '0.009')).toBe(false);
  });
  it('RF-M3-02 "0.00" no es una Rate válida', () => {
    expect(ok(Rate, '0.00')).toBe(false);
  });
  it('RF-M3-02 "0.01" es una Rate válida', () => {
    expect(ok(Rate, '0.01')).toBe(true);
  });
  it('RF-M3-02 "6.96" es una Rate válida', () => {
    expect(ok(Rate, '6.96')).toBe(true);
  });
  it('RF-M3-02 una Rate negativa es inválida', () => {
    expect(ok(Rate, '-6.96')).toBe(false);
  });
});

describe('Note (RF-M6-03)', () => {
  it('RF-M6-03 una nota de 141 caracteres es inválida', () => {
    expect(ok(Note, 'a'.repeat(141))).toBe(false);
  });
  it('RF-M6-03 una nota de 140 caracteres es válida', () => {
    expect(ok(Note, 'a'.repeat(140))).toBe(true);
  });
  it('RF-M6-03 la nota se recorta', () => {
    expect(Note.parse('  hola  ')).toBe('hola');
  });
  it('RF-M6-03 se mide la longitud después de recortar', () => {
    expect(ok(Note, `  ${'a'.repeat(140)}  `)).toBe(true);
  });
  it('RF-M6-03 la nota vacía es válida (opcional)', () => {
    expect(ok(Note.optional(), undefined)).toBe(true);
    expect(ok(Note, '')).toBe(true);
  });
});

describe('TrimmedName (RN-13)', () => {
  it('RN-13 un nombre se valida después de recortar sus espacios', () => {
    const name = TrimmedName(1, 40);
    expect(name.parse('  Caja  ')).toBe('Caja');
  });
  it('RN-13 un nombre solo de espacios es inválido', () => {
    expect(ok(TrimmedName(1, 40), '    ')).toBe(false);
  });
  it('RN-13 el máximo se mide sin los espacios de los bordes', () => {
    const name = TrimmedName(1, 5);
    expect(ok(name, '  abcde  ')).toBe(true);
    expect(ok(name, '  abcdef  ')).toBe(false);
  });
  it('RN-13 respeta el mínimo configurado', () => {
    const name = TrimmedName(3, 10);
    expect(ok(name, ' ab ')).toBe(false);
    expect(ok(name, ' abc ')).toBe(true);
  });
});

describe('LocalDate, CurrencyCode, Uuid, Cursor (plan §4.6.1, §4.3.1)', () => {
  it('TASK-021 LocalDate acepta AAAA-MM-DD y rechaza otros formatos', () => {
    expect(ok(LocalDate, '2026-10-19')).toBe(true);
    expect(ok(LocalDate, '19/10/2026')).toBe(false);
    expect(ok(LocalDate, '2026-10-19T00:00:00Z')).toBe(false);
  });
  it('TASK-021 CurrencyCode son 3 letras mayúsculas', () => {
    expect(ok(CurrencyCode, 'BOB')).toBe(true);
    expect(ok(CurrencyCode, 'usd')).toBe(false);
    expect(ok(CurrencyCode, 'US')).toBe(false);
    expect(ok(CurrencyCode, 'USDT')).toBe(false);
  });
  it('TASK-021 Uuid acepta un UUID y rechaza otros textos', () => {
    expect(ok(Uuid, '0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b')).toBe(true);
    expect(ok(Uuid, 'no-es-uuid')).toBe(false);
  });
  it('TASK-021 Cursor es texto', () => {
    expect(ok(Cursor, 'abc123')).toBe(true);
    expect(ok(Cursor, 12)).toBe(false);
  });
});
