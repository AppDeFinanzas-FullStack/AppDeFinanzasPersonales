import { describe, expect, it } from 'vitest';
import { installment, isFinished, nextDates, skippedDates } from '../src/index.js';

// Conventions used by these tests (plan §4.14.1, contracts `recurring.ts`):
// - A rule carries `frequency`, `startDate` and `end` with the shapes of `CreateRuleInput`.
// - LocalDate is an ISO calendar day 'YYYY-MM-DD'; weekday 0 = Sunday (domain convention).
// - `installment` follows `RuleDto.installment`: `{ current, total }`, or null when the end is not by count.
// - Dates passed as `fromDate`, `pausedAt` and `today` are chosen off the occurrence days, so the
//   tests do not depend on whether those bounds are inclusive (except the daily rule, handled below).

type Frequency =
  | { type: 'daily' }
  | { type: 'weekly'; weekday: number }
  | { type: 'monthly'; day: number }
  | { type: 'yearly'; month: number; day: number };

type End = { type: 'none' } | { type: 'until'; date: string } | { type: 'count'; count: number };

const rule = (frequency: Frequency, end: End = { type: 'none' }, startDate = '2026-10-01') => ({
  frequency,
  startDate,
  end,
});

describe('recurrence: nextDates (RF-M14-01, RF-M14-02)', () => {
  it('RF-M14-01 una regla diaria cae todos los días', () => {
    // 2026-10-22 is itself an occurrence, so accept either inclusive or exclusive `fromDate`.
    const dates = nextDates(rule({ type: 'daily' }), '2026-10-22', 3);
    expect([
      ['2026-10-22', '2026-10-23', '2026-10-24'],
      ['2026-10-23', '2026-10-24', '2026-10-25'],
    ]).toContainEqual(dates);
  });

  it('RF-M14-01 una regla semanal respeta su único día de la semana', () => {
    // 2026-10-22 is a Thursday; weekday 1 = Monday.
    expect(nextDates(rule({ type: 'weekly', weekday: 1 }), '2026-10-22', 3)).toEqual([
      '2026-10-26',
      '2026-11-02',
      '2026-11-09',
    ]);
  });

  it('RF-M14-01 una regla mensual cae el día fijo de cada mes', () => {
    expect(nextDates(rule({ type: 'monthly', day: 15 }), '2026-10-20', 3)).toEqual([
      '2026-11-15',
      '2026-12-15',
      '2027-01-15',
    ]);
  });

  it('RF-M14-01 una regla anual cae el mismo día de cada año', () => {
    expect(nextDates(rule({ type: 'yearly', month: 3, day: 10 }), '2026-10-22', 2)).toEqual([
      '2027-03-10',
      '2028-03-10',
    ]);
  });

  it('EC-M14-01 una regla mensual con el día 31 cae el 30 en noviembre', () => {
    expect(nextDates(rule({ type: 'monthly', day: 31 }), '2026-11-01', 1)).toEqual(['2026-11-30']);
  });

  it('RF-M14-02 el día que no existe cae el último día del mes y vuelve al día elegido en los meses que lo tienen', () => {
    expect(nextDates(rule({ type: 'monthly', day: 31 }), '2026-10-01', 6)).toEqual([
      '2026-10-31',
      '2026-11-30',
      '2026-12-31',
      '2027-01-31',
      '2027-02-28',
      '2027-03-31',
    ]);
  });

  it('RF-M14-02 una regla anual del 29/02 cae el 28/02 en 2027 y el 29/02 en 2028', () => {
    expect(nextDates(rule({ type: 'yearly', month: 2, day: 29 }), '2026-10-22', 2)).toEqual([
      '2027-02-28',
      '2028-02-29',
    ]);
  });
});

describe('recurrence: skippedDates (RF-M14-09, EC-M14-06)', () => {
  it('RF-M14-09 devuelve las ocurrencias saltadas entre la pausa y hoy con su fecha original', () => {
    expect(skippedDates(rule({ type: 'monthly', day: 15 }), '2026-10-20', '2027-01-10')).toEqual([
      '2026-11-15',
      '2026-12-15',
    ]);
  });

  it('EC-M14-06 si el fin pasó durante la pausa, solo se devuelven las fechas hasta el fin', () => {
    const r = rule({ type: 'monthly', day: 15 }, { type: 'until', date: '2026-12-20' });
    expect(skippedDates(r, '2026-10-20', '2027-03-10')).toEqual(['2026-11-15', '2026-12-15']);
  });
});

describe('recurrence: isFinished (RF-M14-09, EC-M14-05, EC-M14-06)', () => {
  it('RF-M14-09 una regla de N veces queda Finalizada al llegar a N ocurrencias generadas', () => {
    const r = rule({ type: 'monthly', day: 15 }, { type: 'count', count: 12 });
    expect(isFinished(r, 11, '2027-10-01')).toBe(false);
    expect(isFinished(r, 12, '2027-10-01')).toBe(true);
  });

  it('EC-M14-05 con 12 veces y 11 generadas, de 2 saltadas solo se puede registrar 1', () => {
    const r = rule({ type: 'monthly', day: 15 }, { type: 'count', count: 12 });
    // Skipped dates count only when registered (RF-M14-09), so the limit is checked on each registration.
    // Registering the first skipped date reaches 12: the rule finishes, so the second cannot be registered.
    expect(isFinished(r, 11, '2027-11-10')).toBe(false);
    expect(isFinished(r, 12, '2027-11-10')).toBe(true);
  });

  it('EC-M14-06 una regla cuya fecha de fin pasó queda Finalizada', () => {
    const r = rule({ type: 'monthly', day: 15 }, { type: 'until', date: '2026-12-20' });
    expect(isFinished(r, 2, '2026-11-01')).toBe(false);
    expect(isFinished(r, 3, '2027-03-10')).toBe(true);
  });

  it('RF-M14-09 una regla sin fin nunca queda Finalizada', () => {
    expect(isFinished(rule({ type: 'daily' }), 999, '2030-01-01')).toBe(false);
  });
});

describe('recurrence: installment (RF-M14-13)', () => {
  it('RF-M14-13 installment da "Cuota 3 de 12" en una regla de 12 veces', () => {
    const r = rule({ type: 'monthly', day: 15 }, { type: 'count', count: 12 });
    const around = [installment(r, 2), installment(r, 3)];
    expect(around).toContainEqual({ current: 3, total: 12 });
    const [before, after] = around;
    expect(before?.total).toBe(12);
    expect(after?.total).toBe(12);
    expect((after?.current ?? 0) - (before?.current ?? 0)).toBe(1);
  });

  it('RF-M14-13 sin fin por cantidad no hay "Cuota X de N"', () => {
    expect(installment(rule({ type: 'monthly', day: 15 }), 3)).toBeNull();
    expect(
      installment(rule({ type: 'monthly', day: 15 }, { type: 'until', date: '2027-12-31' }), 3),
    ).toBeNull();
  });
});
