import { describe, expect, it } from 'vitest';
import { comparisonWindow, pctChange, savingsRate, savingsRateDeltaPp } from '../src/index.js';

// Conventions (plan §4.8.1, money as decimal text, ADR-03):
// - comparisonWindow(month, today) returns { current, previous }, each { from, to } (inclusive 'YYYY-MM-DD').
// - pctChange(current, previous) returns an integer or null; savingsRate(income, expense) an integer or null.
// - savingsRateDeltaPp(current, previous) returns current - previous in points, or null if either is null.

describe('comparisonWindow (RF-M8-04, EC-M8-03)', () => {
  it('RF-M8-04 Comparación por el mismo tramo: el 15/10 compara 1-15 oct con 1-15 sep', () => {
    const w = comparisonWindow('2026-10', '2026-10-15');
    expect(w.current).toEqual({ from: '2026-10-01', to: '2026-10-15' });
    expect(w.previous).toEqual({ from: '2026-09-01', to: '2026-09-15' });
  });

  it('EC-M8-03 el día 31 contra un mes de 30 días compara con el mes completo', () => {
    const w = comparisonWindow('2026-10', '2026-10-31');
    expect(w.current).toEqual({ from: '2026-10-01', to: '2026-10-31' });
    expect(w.previous).toEqual({ from: '2026-09-01', to: '2026-09-30' });
  });

  it('RF-M8-04 el tramo se acota al último día de un mes anterior más corto (marzo contra febrero)', () => {
    const w = comparisonWindow('2026-03', '2026-03-30');
    expect(w.previous).toEqual({ from: '2026-02-01', to: '2026-02-28' });
  });

  it('RF-M8-04 un mes cerrado compara con el mes anterior completo', () => {
    const w = comparisonWindow('2026-09', '2026-10-15');
    expect(w.current).toEqual({ from: '2026-09-01', to: '2026-09-30' });
    expect(w.previous).toEqual({ from: '2026-08-01', to: '2026-08-31' });
  });

  it('RF-M8-04 enero compara con diciembre del año anterior', () => {
    const w = comparisonWindow('2026-01', '2026-03-10');
    expect(w.previous).toEqual({ from: '2025-12-01', to: '2025-12-31' });
  });
});

describe('pctChange (RF-M8-04)', () => {
  it('RF-M8-04 Comparación por el mismo tramo: 1.200 contra 1.000 da +20', () => {
    expect(pctChange('1200.00', '1000.00')).toBe(20);
  });

  it('RF-M8-04 con un valor anterior de 0 da null', () => {
    expect(pctChange('500.00', '0.00')).toBeNull();
  });

  it('RF-M8-04 redondea con la mitad hacia arriba', () => {
    expect(pctChange('1005.00', '1000.00')).toBe(1); // 0.5 -> 1
    expect(pctChange('1004.00', '1000.00')).toBe(0); // 0.4 -> 0
  });

  it('RF-M8-04 una baja da un entero negativo', () => {
    expect(pctChange('800.00', '1000.00')).toBe(-20);
  });
});

describe('savingsRate (RF-M8-03)', () => {
  it('RF-M8-03 tasa = balance / ingresos en entero', () => {
    expect(savingsRate('3000.00', '2000.00')).toBe(33);
  });

  it('RF-M8-03 redondea con la mitad hacia arriba', () => {
    expect(savingsRate('2000.00', '1990.00')).toBe(1); // 0.5 -> 1
  });

  it('RF-M8-03 Tasa de ahorro oculta: ingresos 3.000 y gastos 3.500 da null', () => {
    expect(savingsRate('3000.00', '3500.00')).toBeNull();
  });

  it('RF-M8-03 sin ingresos da null', () => {
    expect(savingsRate('0.00', '0.00')).toBeNull();
    expect(savingsRate('0.00', '100.00')).toBeNull();
  });

  it('RF-M8-03 balance cero da 0', () => {
    expect(savingsRate('1000.00', '1000.00')).toBe(0);
  });
});

describe('savingsRateDeltaPp (RF-M8-04)', () => {
  it('RF-M8-04 la variación son puntos porcentuales', () => {
    expect(savingsRateDeltaPp(33, 30)).toBe(3);
    expect(savingsRateDeltaPp(20, 25)).toBe(-5);
  });

  it('RF-M8-04 da null si falta alguna de las dos tasas', () => {
    expect(savingsRateDeltaPp(null, 30)).toBeNull();
    expect(savingsRateDeltaPp(30, null)).toBeNull();
  });
});
