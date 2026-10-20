import { describe, expect, it } from 'vitest';

import { DashboardDto, DashboardQuery } from '../src/index.js';

const ok = (schema: { safeParse: (v: unknown) => { success: boolean } }, v: unknown) =>
  schema.safeParse(v).success;

const validDto = {
  range: { firstMonth: '2026-01', currentMonth: '2026-10' },
  cards: {
    income: '1000.00',
    expense: '400.00',
    balance: '600.00',
    savingsRatePct: 60,
    variations: { income: '10', expense: '-5', balance: '200.00', savingsRatePp: 3 },
  },
  byCategory: { top: [], others: null },
  pace: { current: [{ day: 1, cumulative: '10.00' }], previous: [] },
  balances: { netWorth: { base: '500.00', other: null }, top: [], asOfToday: true },
  recent: [],
};

describe('DashboardQuery', () => {
  it('RF-M8-01 month exige el formato AAAA-MM', () => {
    expect(ok(DashboardQuery, { month: '2026-10' })).toBe(true);
    expect(ok(DashboardQuery, { month: '2026-1' })).toBe(false);
    expect(ok(DashboardQuery, { month: '2026-10-01' })).toBe(false);
    expect(ok(DashboardQuery, { month: '26-10' })).toBe(false);
    expect(ok(DashboardQuery, { month: 'octubre' })).toBe(false);
    expect(ok(DashboardQuery, { month: '' })).toBe(false);
    expect(ok(DashboardQuery, {})).toBe(false);
  });
});

describe('DashboardDto', () => {
  it('RF-M8-01 incluye el rango de meses del selector', () => {
    expect(ok(DashboardDto, validDto)).toBe(true);
    expect(ok(DashboardDto, { ...validDto, range: undefined })).toBe(false);
  });

  it('RF-M8-03 savingsRatePct admite null', () => {
    expect(
      ok(DashboardDto, { ...validDto, cards: { ...validDto.cards, savingsRatePct: null } }),
    ).toBe(true);
    expect(
      ok(DashboardDto, { ...validDto, cards: { ...validDto.cards, savingsRatePct: 'x' } }),
    ).toBe(false);
  });

  it('RF-M8-03 las variaciones admiten null', () => {
    const variations = { income: null, expense: null, balance: null, savingsRatePp: null };
    expect(ok(DashboardDto, { ...validDto, cards: { ...validDto.cards, variations } })).toBe(true);
  });

  it('TASK-143 budgets y upcoming son opcionales', () => {
    expect(ok(DashboardDto, { ...validDto, budgets: [], upcoming: [] })).toBe(true);
  });
});
