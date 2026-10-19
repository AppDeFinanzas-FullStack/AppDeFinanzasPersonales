import { describe, expect, it } from 'vitest';

import { AppError } from '../../src/application/errors.js';
import { LIMITS, assertLimit } from '../../src/application/shared/limits.js';

type Entity = Parameters<typeof assertLimit>[1];

const entries = Object.entries(LIMITS) as [Entity, number][];

function catchError(fn: () => unknown): unknown {
  try {
    fn();
  } catch (e) {
    return e;
  }
  return undefined;
}

describe('LIMITS', () => {
  it('RNF-28 LIMITS define 7 entidades con los máximos 50, 300, 50, 200, 100, 100 y 12', () => {
    const values = entries.map(([, max]) => max).sort((a, b) => a - b);
    expect(values).toEqual([12, 50, 50, 100, 100, 200, 300]);
  });
});

describe('assertLimit', () => {
  it('RNF-28 hay al menos una entidad para verificar', () => {
    expect(entries).toHaveLength(7);
  });

  for (const [entity, max] of entries) {
    it(`RNF-28 ${entity}: con ${max - 1} pasa`, () => {
      expect(() => assertLimit(max - 1, entity)).not.toThrow();
    });

    it(`RNF-28 ${entity}: con ${max} lanza LIMIT_REACHED con {entity, max}`, () => {
      const err = catchError(() => assertLimit(max, entity));
      expect(err).toBeInstanceOf(AppError);
      const app = err as AppError;
      expect(app.code).toBe('LIMIT_REACHED');
      expect(app.status).toBe(409);
      expect(app.data).toEqual({ entity, max });
    });

    it(`RNF-28 ${entity}: con ${max + 1} también lanza LIMIT_REACHED`, () => {
      const err = catchError(() => assertLimit(max + 1, entity));
      expect((err as AppError).code).toBe('LIMIT_REACHED');
    });

    it(`RNF-28 ${entity}: con 0 pasa`, () => {
      expect(() => assertLimit(0, entity)).not.toThrow();
    });
  }
});
