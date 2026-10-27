import { describe, expect, it } from 'vitest';
import { nextPeriod, periodFor, periodLabel } from '../src/index.js';

// Conventions (plan §4.11.1, BudgetDto.current { start, end }):
// - periodFor(startDay, nextStartDay, date) returns { start, end } as inclusive LocalDate text 'YYYY-MM-DD'.
//   nextStartDay is null when no change of start day is pending.
// - nextPeriod(period, startDay) returns the period that follows, starting at startDay.
// - periodLabel(period) returns a non-empty text for the period.

describe('periodFor (RF-M11-04)', () => {
  it('RF-M11-04 con el día de inicio 15, el 03/11 cae en el período 15/10–14/11', () => {
    expect(periodFor(15, null, '2026-11-03')).toEqual({ start: '2026-10-15', end: '2026-11-14' });
  });

  it('RF-M11-04 el período empieza el mismo día de inicio elegido', () => {
    expect(periodFor(15, null, '2026-10-15')).toEqual({ start: '2026-10-15', end: '2026-11-14' });
    expect(periodFor(15, null, '2026-10-14')).toEqual({ start: '2026-09-15', end: '2026-10-14' });
  });

  it('RF-M11-04 con el día de inicio 1, el período es el mes calendario', () => {
    expect(periodFor(1, null, '2026-10-20')).toEqual({ start: '2026-10-01', end: '2026-10-31' });
    expect(periodFor(1, null, '2026-02-10')).toEqual({ start: '2026-02-01', end: '2026-02-28' });
  });

  it('RF-M11-04 con el día de inicio 28 el período cruza el cambio de año', () => {
    expect(periodFor(28, null, '2027-01-05')).toEqual({ start: '2026-12-28', end: '2027-01-27' });
  });
});

describe('periodFor con cambio del día de inicio (RF-M11-07, EC-M11-07)', () => {
  it('EC-M11-07 al cambiar de 1 a 15 durante octubre, el período va del 01/10 al 14/11', () => {
    expect(periodFor(1, 15, '2026-10-20')).toEqual({ start: '2026-10-01', end: '2026-11-14' });
  });

  it('RF-M11-07 el período en curso alargado incluye los días de noviembre hasta el 14', () => {
    expect(periodFor(1, 15, '2026-11-10')).toEqual({ start: '2026-10-01', end: '2026-11-14' });
    expect(periodFor(1, 15, '2026-11-14')).toEqual({ start: '2026-10-01', end: '2026-11-14' });
  });

  it('EC-M11-07 el siguiente período empieza el 15/11', () => {
    const current = periodFor(1, 15, '2026-10-20');
    expect(nextPeriod(current, 15)).toEqual({ start: '2026-11-15', end: '2026-12-14' });
  });

  it('RF-M11-07 sin cambio pendiente, el siguiente período mantiene el día de inicio', () => {
    expect(nextPeriod({ start: '2026-10-15', end: '2026-11-14' }, 15)).toEqual({
      start: '2026-11-15',
      end: '2026-12-14',
    });
    expect(nextPeriod({ start: '2026-12-01', end: '2026-12-31' }, 1)).toEqual({
      start: '2027-01-01',
      end: '2027-01-31',
    });
  });
});

describe('periodLabel (TASK-194)', () => {
  it('TASK-194 periodLabel devuelve un texto no vacío para el período', () => {
    const label = periodLabel({ start: '2026-10-15', end: '2026-11-14' });
    expect(typeof label).toBe('string');
    expect(label.length).toBeGreaterThan(0);
  });
});
