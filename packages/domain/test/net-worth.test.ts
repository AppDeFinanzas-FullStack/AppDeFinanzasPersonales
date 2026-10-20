import { Decimal } from 'decimal.js';
import { describe, expect, it } from 'vitest';
import { netWorth } from '../src/balance.js';

const rates = (usd: string | null) => ({
  baseCurrency: 'BOB',
  otherCurrency: 'USD',
  bobPerUnit: { BOB: new Decimal(1), USD: usd === null ? null : new Decimal(usd) },
});

describe('netWorth (RF-M4-10, RN-05, RN-06)', () => {
  it('RF-M4-10 una tarjeta con deuda resta del total y entra como deuda en tarjetas', () => {
    const r = netWorth(
      [
        { type: 'bank', currencyCode: 'BOB', balance: '1000.00' },
        { type: 'credit_card', currencyCode: 'BOB', balance: '-300.00' },
      ],
      rates('6.96'),
    );
    expect(r.netWorth.base).toBe('700.00');
    expect(r.breakdown.liquid).toBe('1000.00');
    expect(r.breakdown.cardDebt).toBe('-300.00');
  });

  it('RF-M4-10 un saldo a favor en tarjeta reduce la deuda en tarjetas', () => {
    const r = netWorth(
      [
        { type: 'credit_card', currencyCode: 'BOB', balance: '-300.00' },
        { type: 'credit_card', currencyCode: 'BOB', balance: '50.00' },
      ],
      rates('6.96'),
    );
    expect(r.breakdown.cardDebt).toBe('-250.00');
    expect(r.netWorth.base).toBe('-250.00');
  });

  it('RF-M4-10 el desglose separa líquido, ahorro y tarjetas, con apartado en 0', () => {
    const r = netWorth(
      [
        { type: 'cash', currencyCode: 'BOB', balance: '10.00' },
        { type: 'bank', currencyCode: 'BOB', balance: '20.00' },
        { type: 'ewallet', currencyCode: 'BOB', balance: '30.00' },
        { type: 'other', currencyCode: 'BOB', balance: '40.00' },
        { type: 'savings', currencyCode: 'BOB', balance: '500.00' },
        { type: 'credit_card', currencyCode: 'BOB', balance: '-100.00' },
      ],
      rates('6.96'),
    );
    expect(r.breakdown).toEqual({
      liquid: '100.00',
      savings: '500.00',
      cardDebt: '-100.00',
      earmarked: '0.00',
    });
    expect(r.netWorth.base).toBe('500.00');
  });

  it('RN-05 convierte a la base y a la otra moneda con la referencia vigente', () => {
    const r = netWorth(
      [
        { type: 'cash', currencyCode: 'BOB', balance: '100.00' },
        { type: 'bank', currencyCode: 'USD', balance: '50.00' },
      ],
      rates('6.96'),
    );
    expect(r.netWorth.base).toBe('448.00');
    expect(r.netWorth.other).toBe('64.37');
  });

  it('RN-06 el total en base es la suma de conversiones redondeadas por cuenta', () => {
    const r = netWorth(
      [
        { type: 'bank', currencyCode: 'USD', balance: '0.01' },
        { type: 'bank', currencyCode: 'USD', balance: '0.01' },
        { type: 'bank', currencyCode: 'USD', balance: '0.01' },
      ],
      rates('6.5'),
    );
    expect(r.netWorth.base).toBe('0.21');
  });

  it('RN-06 el equivalente en la otra moneda suma conversiones redondeadas por cuenta', () => {
    const r = netWorth(
      [
        { type: 'cash', currencyCode: 'BOB', balance: '1.00' },
        { type: 'cash', currencyCode: 'BOB', balance: '1.00' },
        { type: 'cash', currencyCode: 'BOB', balance: '1.00' },
      ],
      rates('6.5'),
    );
    expect(r.netWorth.other).toBe('0.45');
  });

  it('RN-06 en negativos la mitad se aleja del cero', () => {
    const r = netWorth(
      [{ type: 'credit_card', currencyCode: 'USD', balance: '-0.01' }],
      rates('6.5'),
    );
    expect(r.netWorth.base).toBe('-0.07');
    expect(r.breakdown.cardDebt).toBe('-0.07');
  });

  it('RF-M4-10 sin tasa de la otra moneda, el equivalente es null y la base se mantiene', () => {
    const r = netWorth([{ type: 'cash', currencyCode: 'BOB', balance: '100.00' }], rates(null));
    expect(r.netWorth.base).toBe('100.00');
    expect(r.netWorth.other).toBeNull();
    expect(r.breakdown.liquid).toBe('100.00');
  });

  it('RF-M4-10 sin tasa de una moneda necesaria, la base y el desglose son null', () => {
    const r = netWorth(
      [
        { type: 'cash', currencyCode: 'BOB', balance: '100.00' },
        { type: 'bank', currencyCode: 'USD', balance: '10.00' },
      ],
      rates(null),
    );
    expect(r.netWorth.base).toBeNull();
    expect(r.netWorth.other).toBeNull();
    expect(r.breakdown).toEqual({ liquid: null, savings: null, cardDebt: null, earmarked: null });
  });

  it('RF-M4-10 si falta solo la tasa de la otra moneda, solo other es null', () => {
    const r = netWorth(
      [
        { type: 'cash', currencyCode: 'BOB', balance: '100.00' },
        { type: 'bank', currencyCode: 'EUR', balance: '10.00' },
      ],
      {
        baseCurrency: 'BOB',
        otherCurrency: 'USD',
        bobPerUnit: { BOB: new Decimal(1), EUR: new Decimal('7.5'), USD: null },
      },
    );
    expect(r.netWorth.base).toBe('175.00');
    expect(r.netWorth.other).toBeNull();
    expect(r.breakdown.liquid).toBe('175.00');
  });

  it('RF-M4-10 sin cuentas el total y el desglose son 0.00', () => {
    const r = netWorth([], rates('6.96'));
    expect(r.netWorth).toEqual({ base: '0.00', other: '0.00' });
    expect(r.breakdown).toEqual({ liquid: '0.00', savings: '0.00', cardDebt: '0.00', earmarked: '0.00' });
  });
});
