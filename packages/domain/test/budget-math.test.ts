import { describe, expect, it } from 'vitest';
import { available, paceText, result, thresholdsCrossed, validateSplit } from '../src/budget.js';

// Conventions (plan §4.11.1, money as decimal text, ADR-03). index.ts is not in this task's scope,
// so the functions are imported straight from src/budget.ts.
// - available(amount, carryoverIn, lateAdjustments) returns decimal text;
//   lateAdjustments are the amounts (decimal text) of the non-voided late adjustments.
// - result(available, spent) returns decimal text (available − spent).
// - validateSplit(result, carry, toGoal, discard) returns RuleResult ({ ok: true } | { ok: false; reason });
//   toGoal is decimal text or null when nothing goes to a goal.
// - thresholdsCrossed(spent, amount, thresholds, alreadyHit, isPeriodStart) returns the thresholds (percent
//   numbers) that must be notified now, measured over the period amount.
// - paceText(available, spent, period, today) returns the pace text for the current period.

const october = { start: '2026-10-01', end: '2026-10-31' };

describe('available (RF-M11-05, EC-M11-01)', () => {
  it('RF-M11-05 disponible = monto del período + arrastre positivo', () => {
    expect(Number(available('300.00', '50.00', []))).toBe(350);
  });

  it('RF-M11-05 los ajustes tardíos no anulados se suman al disponible', () => {
    expect(Number(available('300.00', '0.00', ['-20.00', '5.50']))).toBe(285.5);
  });

  it('EC-M11-01 un arrastre de −400 sobre un monto de 300 da un disponible de −100', () => {
    expect(Number(available('300.00', '-400.00', []))).toBe(-100);
  });

  it('EC-M11-01 el período empieza superado y paceText da "Superado por"', () => {
    const avail = available('300.00', '-400.00', []);
    const text = paceText(avail, '0.00', october, '2026-10-01');
    expect(text).toContain('Superado por');
    expect(text).toContain('100');
  });

  it('RF-M11-05 un período que empieza superado no muestra "Puedes gastar"', () => {
    const text = paceText('-100.00', '0.00', october, '2026-10-01');
    expect(text).not.toContain('Puedes gastar');
  });
});

describe('result (RF-M11-08, RF-M11-14)', () => {
  it('RF-M11-08 sobrante = disponible − gastado', () => {
    expect(Number(result('350.00', '120.25'))).toBe(229.75);
  });

  it('RF-M11-08 exceso: gastado mayor que el disponible da un resultado negativo', () => {
    expect(Number(result('300.00', '340.00'))).toBe(-40);
  });

  it('RF-M11-14 un presupuesto superado sigue sumando el gasto', () => {
    expect(Number(result('300.00', '350.00'))).toBe(-50);
    expect(Number(result('300.00', '420.00'))).toBe(-120);
  });

  it('RF-M11-14 un presupuesto superado se muestra como superado con el exceso acumulado', () => {
    const first = paceText('300.00', '350.00', october, '2026-10-20');
    const later = paceText('300.00', '420.00', october, '2026-10-21');
    expect(first).toContain('Superado por');
    expect(first).toContain('50');
    expect(later).toContain('Superado por');
    expect(later).toContain('120');
  });
});

describe('validateSplit (RF-M11-08)', () => {
  it('RF-M11-08 un reparto que suma exacto el sobrante es válido', () => {
    expect(validateSplit('100.00', '40.00', '35.50', '24.50').ok).toBe(true);
    expect(validateSplit('100.00', '100.00', null, '0.00').ok).toBe(true);
  });

  it('RF-M11-08 un reparto que no suma exacto es inválido', () => {
    expect(validateSplit('100.00', '40.00', '35.50', '24.49').ok).toBe(false);
    expect(validateSplit('100.00', '60.00', null, '40.01').ok).toBe(false);
    expect(validateSplit('100.00', '50.00', '30.00', '10.00').ok).toBe(false);
  });
});

describe('thresholdsCrossed (RF-M11-13)', () => {
  it('RF-M11-13 si un período empieza en el 120 % con umbrales 80 y 100, solo se avisa el 100', () => {
    expect(thresholdsCrossed('360.00', '300.00', [80, 100], [], true)).toEqual([100]);
  });

  it('RF-M11-13 los umbrales se miden sobre el monto del período, no sobre el disponible', () => {
    // 240 de 300 es el 80 % del monto, aunque el disponible con arrastre sea mayor.
    expect(thresholdsCrossed('240.00', '300.00', [80, 100], [], false)).toEqual([80]);
    expect(thresholdsCrossed('239.99', '300.00', [80, 100], [], false)).toEqual([]);
  });

  it('RF-M11-13 cada umbral avisa una sola vez por período', () => {
    expect(thresholdsCrossed('250.00', '300.00', [80, 100], [80], false)).toEqual([]);
    expect(thresholdsCrossed('300.00', '300.00', [80, 100], [80], false)).toEqual([100]);
  });
});

describe('paceText (plan §4.11.1)', () => {
  it('TASK-195 con disponible positivo y por debajo del ritmo dice "Puedes gastar X/día durante N días"', () => {
    const text = paceText('300.00', '0.00', october, '2026-10-02');
    expect(text).toContain('Puedes gastar');
    expect(text).toContain('/día durante');
    expect(text).toContain('días');
  });

  it('TASK-195 con gasto por encima del ritmo sin superar el disponible dice "por encima del ritmo"', () => {
    // A día 2 de 31, el ritmo ideal está muy por debajo de 290.
    const text = paceText('300.00', '290.00', october, '2026-10-02');
    expect(text).toContain('por encima del ritmo');
    expect(text).not.toContain('Superado por');
  });
});
