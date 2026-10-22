import { describe, expect, it } from 'vitest';

import {
  DEFAULT_PREFERENCES,
  NotificationsQuery,
  NotificationType,
  PreferencesInput,
} from '../src/index.js';

const ok = (schema: { safeParse: (v: unknown) => { success: boolean } }, v: unknown) =>
  schema.safeParse(v).success;

const TYPES = [
  'payment_upcoming',
  'budget_alert',
  'period_close',
  'recurring_pending',
  'log_day',
  'goal_progress',
];

type Pref = { enabled?: unknown; hour?: unknown; [k: string]: unknown };

// DEFAULT_PREFERENCES puede ser una lista de filas { type, ... } o un objeto por tipo.
const defaultFor = (type: string): Pref | undefined => {
  const value: unknown = DEFAULT_PREFERENCES;
  if (Array.isArray(value)) {
    return (value as Pref[]).find((p) => p.type === type);
  }
  return (value as Record<string, Pref | undefined>)[type];
};

const allDefaults = (): Pref[] => TYPES.map((t) => defaultFor(t)).filter((p) => p !== undefined);

describe('NotificationType', () => {
  it('RF-M15-08 tiene exactamente los 6 tipos del plan', () => {
    expect([...NotificationType.options].sort()).toEqual([...TYPES].sort());
    for (const t of TYPES) expect(ok(NotificationType, t)).toBe(true);
  });

  it('RF-M15-08 no existe un tipo de cambio fuerte del dolar', () => {
    for (const t of ['fx_change', 'fx_alert', 'dollar_change', 'usd_change', 'rate_change']) {
      expect(ok(NotificationType, t)).toBe(false);
    }
    for (const t of NotificationType.options) {
      expect(t).not.toMatch(/fx|dollar|usd|rate/i);
    }
  });

  it('RF-M15-01 ningun tipo es de correo ni push', () => {
    for (const t of NotificationType.options) {
      expect(t).not.toMatch(/email|mail|push/i);
    }
  });
});

describe('DEFAULT_PREFERENCES', () => {
  it('RF-M15-02 define un valor por defecto para cada uno de los 6 tipos', () => {
    for (const t of TYPES) expect(defaultFor(t)).toBeDefined();
  });

  it('RF-M15-02 payment_upcoming, budget_alert, period_close y recurring_pending activos', () => {
    for (const t of ['payment_upcoming', 'budget_alert', 'period_close', 'recurring_pending']) {
      expect(defaultFor(t)?.enabled).toBe(true);
    }
  });

  it('RF-M15-02 log_day y goal_progress desactivados', () => {
    expect(defaultFor('log_day')?.enabled).toBe(false);
    expect(defaultFor('goal_progress')?.enabled).toBe(false);
  });

  it('RF-M15-02 log_day a las 21', () => {
    expect(defaultFor('log_day')?.hour).toBe(21);
  });

  it('RF-M15-01 los valores por defecto no tienen canal de correo ni push', () => {
    for (const p of allDefaults()) {
      for (const key of Object.keys(p)) {
        expect(key).not.toMatch(/channel|email|mail|push/i);
      }
    }
  });
});

describe('PreferencesInput', () => {
  it('TASK-175 acepta una lista valida', () => {
    expect(
      ok(PreferencesInput, [
        { type: 'log_day', enabled: true, hour: 21, weekdays: [0, 1, 2, 3, 4, 5, 6] },
        { type: 'payment_upcoming', enabled: true, leadDays: 3 },
        { type: 'goal_progress', enabled: false },
      ]),
    ).toBe(true);
  });

  it('TASK-175 limita la hora a 0-23', () => {
    expect(ok(PreferencesInput, [{ type: 'log_day', enabled: true, hour: 0 }])).toBe(true);
    expect(ok(PreferencesInput, [{ type: 'log_day', enabled: true, hour: 23 }])).toBe(true);
    expect(ok(PreferencesInput, [{ type: 'log_day', enabled: true, hour: 24 }])).toBe(false);
    expect(ok(PreferencesInput, [{ type: 'log_day', enabled: true, hour: -1 }])).toBe(false);
    expect(ok(PreferencesInput, [{ type: 'log_day', enabled: true, hour: 20.5 }])).toBe(false);
  });

  it('TASK-175 limita la anticipacion a 0-7', () => {
    const p = (leadDays: number) => [{ type: 'payment_upcoming', enabled: true, leadDays }];
    expect(ok(PreferencesInput, p(0))).toBe(true);
    expect(ok(PreferencesInput, p(7))).toBe(true);
    expect(ok(PreferencesInput, p(8))).toBe(false);
    expect(ok(PreferencesInput, p(-1))).toBe(false);
    expect(ok(PreferencesInput, p(1.5))).toBe(false);
  });

  it('TASK-175 limita los dias de la semana a 0-6', () => {
    const p = (weekdays: number[]) => [{ type: 'log_day', enabled: true, weekdays }];
    expect(ok(PreferencesInput, p([0, 6]))).toBe(true);
    expect(ok(PreferencesInput, p([7]))).toBe(false);
    expect(ok(PreferencesInput, p([-1]))).toBe(false);
  });

  it('RF-M15-08 rechaza un tipo de cambio del dolar', () => {
    expect(ok(PreferencesInput, [{ type: 'fx_change', enabled: true }])).toBe(false);
  });
});

describe('NotificationsQuery', () => {
  it('TASK-175 limit por defecto es 20', () => {
    const r = NotificationsQuery.parse({});
    expect(r.limit).toBe(20);
    expect(r.cursor).toBeUndefined();
  });

  it('TASK-175 limit maximo es 50', () => {
    expect(ok(NotificationsQuery, { limit: 50 })).toBe(true);
    expect(ok(NotificationsQuery, { limit: 51 })).toBe(false);
    expect(ok(NotificationsQuery, { cursor: 'abc', limit: 10 })).toBe(true);
  });
});
