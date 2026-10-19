import { Decimal } from 'decimal.js';
import { describe, expect, it } from 'vitest';
import { classifyBidAsk, gap } from '../src/index.js';

const d = (v: string): Decimal => new Decimal(v);

describe('classifyBidAsk (ADR-06)', () => {
  it('TASK-078 classifyBidAsk(10.30, 10.10) da compra 10,10 y venta 10,30', () => {
    const r = classifyBidAsk(d('10.30'), d('10.10'));
    expect(r.bid.toFixed(2)).toBe('10.10');
    expect(r.ask.toFixed(2)).toBe('10.30');
  });

  it('TASK-078 el orden de los argumentos no cambia el resultado', () => {
    const r = classifyBidAsk(d('10.10'), d('10.30'));
    expect(r.bid.toFixed(2)).toBe('10.10');
    expect(r.ask.toFixed(2)).toBe('10.30');
  });

  it('TASK-078 con valores iguales compra y venta coinciden', () => {
    const r = classifyBidAsk(d('6.96'), d('6.96'));
    expect(r.bid.toFixed(2)).toBe('6.96');
    expect(r.ask.toFixed(2)).toBe('6.96');
  });
});

describe('gap (RF-M3-12)', () => {
  it('RF-M3-12 con paralelo 10,25 y oficial 6,96 la brecha es 47,27 % y Bs 3,29', () => {
    const r = gap(d('10.25'), d('6.96'));
    expect(r.pct.toFixed(2)).toBe('47.27');
    expect(r.bs.toFixed(2)).toBe('3.29');
  });

  it('RF-M3-12 si el paralelo es menor que el oficial la brecha es negativa', () => {
    const r = gap(d('6.00'), d('6.96'));
    expect(r.pct.toFixed(2)).toBe('-13.79');
    expect(r.bs.toFixed(2)).toBe('-0.96');
  });

  it('RF-M3-12 con paralelo igual al oficial la brecha es cero', () => {
    const r = gap(d('6.96'), d('6.96'));
    expect(r.pct.toFixed(2)).toBe('0.00');
    expect(r.bs.toFixed(2)).toBe('0.00');
  });
});
