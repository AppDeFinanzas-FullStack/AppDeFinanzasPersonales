import { describe, expect, it } from 'vitest';

import { MODULE_RELEASE, isReleased, releasedNotificationTypes } from '../src/index.js';

const V10_MODULES = ['M1', 'M2', 'M3', 'M4', 'M5', 'M6', 'M7', 'M8', 'M9', 'M10'] as const;
const V11_MODULES = ['M11', 'M12', 'M13'] as const;
const V12_MODULES = ['M14'] as const;
const ALL_MODULES = [...V10_MODULES, ...V11_MODULES, 'M15', ...V12_MODULES] as const;

describe('MODULE_RELEASE (RF-M2-03, spec 1.2)', () => {
  it('RF-M2-03 define una entrega para los 15 módulos', () => {
    expect(Object.keys(MODULE_RELEASE).sort()).toEqual([...ALL_MODULES].sort());
  });
  it('RF-M2-03 M1 a M10 pertenecen a la 1.0', () => {
    for (const m of V10_MODULES) expect(MODULE_RELEASE[m]).toBe('1.0');
  });
  it('RF-M2-03 M11, M12 y M13 pertenecen a la 1.1', () => {
    for (const m of V11_MODULES) expect(MODULE_RELEASE[m]).toBe('1.1');
  });
  it('RF-M2-03 la bandeja de M15 sale en la 1.1', () => {
    expect(MODULE_RELEASE.M15).toBe('1.1');
  });
  it('RF-M2-03 M14 pertenece a la 1.2', () => {
    expect(MODULE_RELEASE.M14).toBe('1.2');
  });
});

describe('isReleased (RF-M2-03)', () => {
  it('RF-M2-03 con 1.0 están liberados M1 a M10', () => {
    for (const m of V10_MODULES) expect(isReleased(m, '1.0')).toBe(true);
  });
  it('RF-M2-03 con 1.0 no están liberados M11 a M15', () => {
    for (const m of ['M11', 'M12', 'M13', 'M14', 'M15'] as const) {
      expect(isReleased(m, '1.0')).toBe(false);
    }
  });
  it('RF-M2-03 con 1.1 se liberan M11, M12, M13 y la bandeja de M15', () => {
    for (const m of [...V10_MODULES, ...V11_MODULES, 'M15'] as const) {
      expect(isReleased(m, '1.1')).toBe(true);
    }
  });
  it('RF-M2-03 con 1.1 M14 sigue sin liberarse', () => {
    expect(isReleased('M14', '1.1')).toBe(false);
  });
  it('RF-M2-03 con 1.2 está todo liberado', () => {
    for (const m of ALL_MODULES) expect(isReleased(m, '1.2')).toBe(true);
  });
});

describe('releasedNotificationTypes (RF-M2-03, plan 4.15.3)', () => {
  it('RF-M2-03 con 1.0 no hay tipos de aviso', () => {
    expect(releasedNotificationTypes('1.0')).toEqual([]);
  });
  it('RF-M2-03 con 1.1 solo budget_alert, period_close y payment_upcoming', () => {
    expect([...releasedNotificationTypes('1.1')].sort()).toEqual(
      ['budget_alert', 'payment_upcoming', 'period_close'].sort(),
    );
  });
  it('RF-M2-03 con 1.2 están los seis tipos', () => {
    expect([...releasedNotificationTypes('1.2')].sort()).toEqual(
      [
        'budget_alert',
        'goal_progress',
        'log_day',
        'payment_upcoming',
        'period_close',
        'recurring_pending',
      ].sort(),
    );
  });
});
