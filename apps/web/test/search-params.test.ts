import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { parseSearch, serializeSearch, useValidatedSearch } from '../src/lib/search-params';

// A screen's search schema: the month, the filters and the open detail live in
// the URL (ADR-16). Every parameter declares its default value.
const DEFAULT_MONTH = '2026-10';

const movementsSearch = z.object({
  mes: z
    .string()
    .regex(/^\d{4}-(0[1-9]|1[0-2])$/)
    .default(DEFAULT_MONTH),
  tipo: z.enum(['todos', 'ingreso', 'gasto', 'transferencia']).default('todos'),
  cuenta: z.string().min(1).default('todas'),
  detalle: z.string().min(1).default('ninguno'),
});

type MovementsSearch = z.infer<typeof movementsSearch>;

function roundTrip(values: MovementsSearch) {
  return parseSearch(movementsSearch, new URLSearchParams(serializeSearch(values)));
}

describe('parseSearch y serializeSearch', () => {
  it('RF-M2-06 parsear lo serializado devuelve los mismos valores (ida y vuelta)', () => {
    const values: MovementsSearch = {
      mes: '2026-03',
      tipo: 'gasto',
      cuenta: 'acc-123',
      detalle: 'mov-456',
    };

    expect(roundTrip(values)).toEqual(values);
  });

  it('RF-M2-06 serializar lo parseado produce la misma URL (estado estable para el botón Atrás)', () => {
    const url = new URLSearchParams({
      mes: '2025-12',
      tipo: 'ingreso',
      cuenta: 'acc-9',
      detalle: 'mov-1',
    });

    const first = parseSearch(movementsSearch, url);
    const firstQuery = new URLSearchParams(serializeSearch(first));
    const second = parseSearch(movementsSearch, firstQuery);
    const secondQuery = new URLSearchParams(serializeSearch(second));

    expect(second).toEqual(first);
    expect(secondQuery.toString()).toBe(firstQuery.toString());
  });

  it('RF-M2-06 una URL con los parámetros de una pantalla restaura exactamente ese estado', () => {
    const url = new URLSearchParams('mes=2026-01&tipo=transferencia&cuenta=acc-7&detalle=mov-8');

    expect(parseSearch(movementsSearch, url)).toEqual({
      mes: '2026-01',
      tipo: 'transferencia',
      cuenta: 'acc-7',
      detalle: 'mov-8',
    });
  });

  it('RF-M2-04 el mes, los filtros y el detalle abierto se conservan al ir y volver por la URL', () => {
    const tabState: MovementsSearch = {
      mes: '2024-07',
      tipo: 'ingreso',
      cuenta: 'cuenta con espacios & símbolos',
      detalle: 'mov-ñandú/1?x=2',
    };

    expect(roundTrip(tabState)).toEqual(tabState);
  });

  it('RF-M2-04 una URL sin parámetros toma los valores por defecto', () => {
    expect(parseSearch(movementsSearch, new URLSearchParams())).toEqual({
      mes: DEFAULT_MONTH,
      tipo: 'todos',
      cuenta: 'todas',
      detalle: 'ninguno',
    });
  });

  it('TASK-044 un mes con formato inválido cae al valor por defecto sin lanzar errores', () => {
    for (const invalid of ['2026-13', '2026-1', 'marzo', '', '26-03', '2026-03-01']) {
      const url = new URLSearchParams({ mes: invalid });

      expect(() => parseSearch(movementsSearch, url)).not.toThrow();
      expect(parseSearch(movementsSearch, url).mes).toBe(DEFAULT_MONTH);
    }
  });

  it('TASK-044 un parámetro inválido cae a su valor por defecto y los válidos se conservan', () => {
    const url = new URLSearchParams('mes=no-es-mes&tipo=desconocido&cuenta=acc-5&detalle=mov-2');

    expect(parseSearch(movementsSearch, url)).toEqual({
      mes: DEFAULT_MONTH,
      tipo: 'todos',
      cuenta: 'acc-5',
      detalle: 'mov-2',
    });
  });

  it('TASK-044 parseSearch no modifica la URL que recibe', () => {
    const url = new URLSearchParams('mes=mal&tipo=gasto');
    const before = url.toString();

    parseSearch(movementsSearch, url);

    expect(url.toString()).toBe(before);
  });
});

describe('useValidatedSearch', () => {
  it('TASK-044 useValidatedSearch se exporta como hook', () => {
    expect(typeof useValidatedSearch).toBe('function');
  });
});
