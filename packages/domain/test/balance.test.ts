import { describe, expect, it } from 'vitest';
import { balanceFrom, cardView, validateInitialBalance, validateTypeChange } from '../src/index.js';

// Conventions (plan §4.4.2, money as decimal text, ADR-03):
// - entries are { date: 'YYYY-MM-DD', amount: string } with signed amounts (inflow +, outflow -).
// - validators return { ok: true } or { ok: false, reason: string }.
// - cardView returns { label, availableCredit, overLimit }; availableCredit is null without limit.

const base = {
  from: 'bank',
  to: 'cash',
  initialBalance: '0.00',
  currentBalance: '100.00',
  dedicated: false,
  hasEarmarks: false,
} as const;

describe('balanceFrom (RN-01, RN-12)', () => {
  it('RN-01 saldo = inicial + entradas - salidas', () => {
    const entries = [
      { date: '2026-10-05', amount: '100.00' },
      { date: '2026-10-06', amount: '-30.50' },
    ];
    expect(Number(balanceFrom('50.00', '2026-10-01', entries))).toBe(119.5);
  });

  it('RN-01 un asiento de la misma fecha del saldo inicial sí suma', () => {
    expect(Number(balanceFrom('10.00', '2026-10-01', [{ date: '2026-10-01', amount: '5.00' }]))).toBe(15);
  });

  it('RN-01 / RN-12 un asiento anterior al saldo inicial no suma', () => {
    const entries = [
      { date: '2026-09-30', amount: '999.00' },
      { date: '2026-10-02', amount: '1.00' },
    ];
    expect(Number(balanceFrom('50.00', '2026-10-01', entries))).toBe(51);
  });

  it('RN-01 sin asientos el saldo es el inicial', () => {
    expect(Number(balanceFrom('-20.00', '2026-10-01', []))).toBe(-20);
  });

  it('RN-01 suma decimales sin error de punto flotante', () => {
    const entries = [
      { date: '2026-10-02', amount: '0.10' },
      { date: '2026-10-03', amount: '0.20' },
    ];
    expect(balanceFrom('0.00', '2026-10-01', entries)).toMatch(/^0\.30?$/);
  });
});

describe('validateInitialBalance (RF-M4-02)', () => {
  it('RF-M4-02 efectivo con -1 se rechaza', () => {
    const res = validateInitialBalance('cash', '-1');
    expect(res.ok).toBe(false);
  });

  it('RF-M4-02 billetera con -1 se rechaza', () => {
    expect(validateInitialBalance('ewallet', '-1').ok).toBe(false);
  });

  it('RF-M4-02 efectivo con 0 se acepta', () => {
    expect(validateInitialBalance('cash', '0').ok).toBe(true);
  });

  it('RF-M4-02 banco con -1 se acepta', () => {
    expect(validateInitialBalance('bank', '-1').ok).toBe(true);
  });

  it('RF-M4-02 ahorro y otro aceptan negativos', () => {
    expect(validateInitialBalance('savings', '-5').ok).toBe(true);
    expect(validateInitialBalance('other', '-5').ok).toBe(true);
  });

  it('RF-M4-02 tarjeta acepta deuda (negativo) y saldo a favor (positivo)', () => {
    expect(validateInitialBalance('credit_card', '-300.00').ok).toBe(true);
    expect(validateInitialBalance('credit_card', '300.00').ok).toBe(true);
  });

  it('RF-M4-02 el valor absoluto llega hasta 999.999.999,99', () => {
    expect(validateInitialBalance('bank', '999999999.99').ok).toBe(true);
    expect(validateInitialBalance('bank', '-999999999.99').ok).toBe(true);
    expect(validateInitialBalance('bank', '1000000000.00').ok).toBe(false);
    expect(validateInitialBalance('bank', '-1000000000.00').ok).toBe(false);
  });

  it('RF-M4-02 admite 2 decimales como máximo', () => {
    expect(validateInitialBalance('bank', '1.23').ok).toBe(true);
    expect(validateInitialBalance('bank', '1.234').ok).toBe(false);
  });

  it('RF-M4-02 un rechazo informa el motivo', () => {
    const res = validateInitialBalance('cash', '-1');
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason.length).toBeGreaterThan(0);
  });
});

describe('cardView (RF-M4-08)', () => {
  it('RF-M4-08 saldo negativo se muestra como "Debes X"', () => {
    const view = cardView('-300.00', null);
    expect(view.label.startsWith('Debes ')).toBe(true);
    expect(view.label).toContain('300');
  });

  it('RF-M4-08 saldo positivo se muestra como "A favor X"', () => {
    const view = cardView('150.00', null);
    expect(view.label.startsWith('A favor ')).toBe(true);
    expect(view.label).toContain('150');
  });

  it('RF-M4-08 con límite 5.000 y deuda 1.200 el crédito disponible es 3.800 y no está superado', () => {
    const view = cardView('-1200.00', '5000.00');
    expect(Number(view.availableCredit)).toBe(3800);
    expect(view.overLimit).toBe(false);
  });

  it('RF-M4-08 con límite 5.000 y deuda 5.200, el crédito disponible es -200 y está superado', () => {
    const view = cardView('-5200.00', '5000.00');
    expect(Number(view.availableCredit)).toBe(-200);
    expect(view.overLimit).toBe(true);
  });

  it('RF-M4-08 sin límite no hay crédito disponible ni aviso', () => {
    const view = cardView('-5200.00', null);
    expect(view.availableCredit).toBeNull();
    expect(view.overLimit).toBe(false);
  });

  it('RF-M4-08 deuda igual al límite no supera el límite', () => {
    const view = cardView('-5000.00', '5000.00');
    expect(Number(view.availableCredit)).toBe(0);
    expect(view.overLimit).toBe(false);
  });
});

describe('validateTypeChange (RF-M4-07, plan §4.4.2)', () => {
  it('RF-M4-07 un cambio válido se acepta', () => {
    expect(validateTypeChange({ ...base }).ok).toBe(true);
  });

  it('RF-M4-07 no se puede pasar a efectivo con saldo inicial negativo', () => {
    const res = validateTypeChange({ ...base, initialBalance: '-10.00' });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason.length).toBeGreaterThan(0);
  });

  it('RF-M4-07 no se puede pasar a billetera con saldo inicial negativo', () => {
    expect(validateTypeChange({ ...base, to: 'ewallet', initialBalance: '-10.00' }).ok).toBe(false);
  });

  it('RF-M4-07 no se puede pasar a efectivo si el saldo actual queda negativo', () => {
    expect(validateTypeChange({ ...base, currentBalance: '-0.01' }).ok).toBe(false);
  });

  it('RF-M4-07 pasar a banco con saldos negativos se acepta', () => {
    const res = validateTypeChange({
      ...base,
      from: 'cash',
      to: 'bank',
      initialBalance: '-10.00',
      currentBalance: '-5.00',
    });
    expect(res.ok).toBe(true);
  });

  it('RF-M4-07 no se puede pasar a tarjeta una cuenta dedicada', () => {
    const res = validateTypeChange({ ...base, to: 'credit_card', dedicated: true });
    expect(res.ok).toBe(false);
  });

  it('RF-M4-07 no se puede pasar a tarjeta una cuenta con apartados', () => {
    expect(validateTypeChange({ ...base, to: 'credit_card', hasEarmarks: true }).ok).toBe(false);
  });

  it('RF-M4-07 una cuenta sin dedicar ni apartados pasa a tarjeta', () => {
    expect(validateTypeChange({ ...base, to: 'credit_card' }).ok).toBe(true);
  });

  it('RF-M4-07 los motivos de rechazo distinguen los casos', () => {
    const a = validateTypeChange({ ...base, initialBalance: '-10.00' });
    const b = validateTypeChange({ ...base, to: 'credit_card', dedicated: true });
    expect(a.ok || b.ok).toBe(false);
    if (!a.ok && !b.ok) expect(a.reason).not.toBe(b.reason);
  });
});
