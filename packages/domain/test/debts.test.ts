import { Decimal } from 'decimal.js';
import { describe, expect, it } from 'vitest';
import { accrue, dailyRate, proposeSplit, validatePayment } from '../src/debts.js';

const d = (v: string): Decimal => new Decimal(v);

/** Consecutive local dates starting at `start` (UTC calendar arithmetic). */
const nextDay = (date: string): string => {
  const ms = Date.parse(`${date}T00:00:00Z`) + 24 * 60 * 60 * 1000;
  return new Date(ms).toISOString().slice(0, 10);
};

describe('dailyRate (RF-M13-02)', () => {
  it('RF-M13-02 la tasa diaria mensual es la tasa ÷ 100 ÷ 30', () => {
    expect(dailyRate(d('2'), 'monthly').toFixed(15)).toBe(d('2').div(100).div(30).toFixed(15));
  });

  it('RF-M13-02 la tasa diaria anual es la tasa ÷ 100 ÷ 365', () => {
    expect(dailyRate(d('12'), 'yearly').toFixed(15)).toBe(d('12').div(100).div(365).toFixed(15));
  });
});

describe('accrue (RF-M13-02, EC-M13-02, RNF-18)', () => {
  it('RF-M13-02 Bs 2.000 al 2 % mensual durante 30 días acumulan 40,00', () => {
    const interest = accrue(d('2000'), d('0'), dailyRate(d('2'), 'monthly'), '2026-01-01', '2026-01-31');
    expect(interest.toFixed(2)).toBe('40.00');
  });

  it('RF-M13-02 el interés corre aunque la fecha de inicio sea pasada', () => {
    const interest = accrue(d('3000'), d('0'), dailyRate(d('1'), 'monthly'), '2025-01-01', '2025-01-11');
    expect(interest.toFixed(2)).toBe('10.00');
  });

  it('RF-M13-02 se acumula con precisión exacta y no se redondea a 2 decimales', () => {
    const interest = accrue(d('1000'), d('0'), dailyRate(d('1'), 'monthly'), '2026-01-01', '2026-01-02');
    expect(interest.toFixed(2)).toBe('0.33');
    expect(interest.equals(d('0.33'))).toBe(false);
  });

  it('EC-M13-02 con capital 0 no se acumula más interés', () => {
    const interest = accrue(d('0'), d('0'), dailyRate(d('2'), 'monthly'), '2026-01-01', '2026-03-01');
    expect(interest.isZero()).toBe(true);
  });

  it('RNF-18 365 acumulaciones diarias no acumulan error de redondeo', () => {
    const rate = dailyRate(d('12'), 'yearly');
    const capital = d('10000');
    let total = d('0');
    let day = '2026-01-01';
    for (let i = 0; i < 365; i += 1) {
      const next = nextDay(day);
      total = total.plus(accrue(capital, d('0'), rate, day, next));
      day = next;
    }
    const once = accrue(capital, d('0'), rate, '2026-01-01', day);
    expect(total.toFixed(2)).toBe('1200.00');
    expect(once.toFixed(2)).toBe('1200.00');
  });
});

describe('proposeSplit (RF-M13-05)', () => {
  it('RF-M13-05 Desglose precargado: interés 42,30 y pago 500 proponen 42,30 y 457,70', () => {
    const split = proposeSplit(d('500.00'), d('42.30'), d('2000.00'));
    expect(split.interestPart.toFixed(2)).toBe('42.30');
    expect(split.capitalPart.toFixed(2)).toBe('457.70');
  });

  it('RF-M13-05 un pago menor que el interés va todo a interés', () => {
    const split = proposeSplit(d('30.00'), d('42.30'), d('2000.00'));
    expect(split.interestPart.toFixed(2)).toBe('30.00');
    expect(split.capitalPart.toFixed(2)).toBe('0.00');
  });
});

describe('validatePayment (RF-M13-05, RF-M13-06, EC-M13-01)', () => {
  const base = { interestAccrued: d('42.30'), capitalOutstanding: d('2000.00') };

  it('RF-M13-05 un desglose que cumple las reglas es válido', () => {
    const result = validatePayment({
      ...base,
      amount: d('500.00'),
      interestPart: d('42.30'),
      capitalPart: d('457.70'),
    });
    expect(result.ok).toBe(true);
  });

  it('RF-M13-05 el interés no puede superar el interés acumulado', () => {
    const result = validatePayment({
      ...base,
      amount: d('500.00'),
      interestPart: d('50.00'),
      capitalPart: d('450.00'),
    });
    expect(result).toEqual({ ok: false, reason: 'SPLIT_INVALID' });
  });

  it('RF-M13-05 el capital no puede superar el capital pendiente', () => {
    const result = validatePayment({
      interestAccrued: d('42.30'),
      capitalOutstanding: d('100.00'),
      amount: d('120.00'),
      interestPart: d('0.00'),
      capitalPart: d('120.00'),
    });
    expect(result).toEqual({ ok: false, reason: 'SPLIT_INVALID' });
  });

  it('RF-M13-05 interés + capital debe ser exactamente el monto del pago', () => {
    const result = validatePayment({
      ...base,
      amount: d('500.00'),
      interestPart: d('42.30'),
      capitalPart: d('457.69'),
    });
    expect(result).toEqual({ ok: false, reason: 'SPLIT_INVALID' });
  });

  it('RF-M13-06 un pago igual al saldo pendiente es válido', () => {
    const result = validatePayment({
      ...base,
      amount: d('2042.30'),
      interestPart: d('42.30'),
      capitalPart: d('2000.00'),
    });
    expect(result.ok).toBe(true);
  });

  it('EC-M13-01 un pago mayor que el saldo pendiente es inválido', () => {
    const result = validatePayment({
      ...base,
      amount: d('2042.31'),
      interestPart: d('42.30'),
      capitalPart: d('2000.01'),
    });
    expect(result).toEqual({ ok: false, reason: 'PAYMENT_EXCEEDS_BALANCE' });
  });

  it('RF-M13-06 un pago no puede superar el saldo pendiente', () => {
    const result = validatePayment({
      interestAccrued: d('15.00'),
      capitalOutstanding: d('0.00'),
      amount: d('20.00'),
      interestPart: d('15.00'),
      capitalPart: d('5.00'),
    });
    expect(result).toEqual({ ok: false, reason: 'PAYMENT_EXCEEDS_BALANCE' });
  });
});
