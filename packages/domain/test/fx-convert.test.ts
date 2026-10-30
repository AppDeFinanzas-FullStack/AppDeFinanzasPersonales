import { Decimal } from 'decimal.js';
import { describe, expect, it } from 'vitest';
import { amountInFrom, convert, customRateOn, rateFromAmounts, transferPrefill } from '../src/fx.js';
import type { FxEvent } from '../src/fx.js';

const TZ = 'America/La_Paz';
const d = (v: string): Decimal => new Decimal(v);
const at = (iso: string): Date => new Date(iso);

const custom = (code: string, value: string, iso: string): FxEvent => ({
  kind: 'custom_rate',
  currencyCode: code,
  reference: null,
  value: d(value),
  effectiveAt: at(iso),
});

const PARALLEL = { bid: d('10.10'), ask: d('10.30') };
const DATE = '2026-10-19';

describe('convert (RN-06, RN-05)', () => {
  it('RN-06 convierte USD a BOB con 2 decimales', () => {
    expect(convert(d('100'), d('10.30'), d('1')).toFixed(2)).toBe('1030.00');
  });

  it('RN-06 convierte BOB a USD redondeando a 2 decimales', () => {
    expect(convert(d('1000'), d('1'), d('10.30')).toFixed(2)).toBe('97.09');
  });

  it('RN-06 la mitad se redondea hacia arriba', () => {
    expect(convert(d('0.05'), d('0.10'), d('1')).toFixed(2)).toBe('0.01');
  });

  it('RN-06 en negativos la mitad se aleja del cero (-0,005 -> -0,01)', () => {
    expect(convert(d('-0.05'), d('0.10'), d('1')).toFixed(2)).toBe('-0.01');
  });

  it('RN-05 RNF-19 convierte entre dos monedas a través de BOB con las tasas que recibe', () => {
    // 10 EUR a 7.50 Bs, base USD a 10.30 Bs -> 75 / 10.30 = 7.28
    expect(convert(d('10'), d('7.50'), d('10.30')).toFixed(2)).toBe('7.28');
  });
});

describe('customRateOn (equivale a user_rate_on)', () => {
  const events: FxEvent[] = [
    custom('EUR', '7.80', '2026-10-15T12:00:00Z'),
    custom('EUR', '7.50', '2026-10-10T12:00:00Z'),
    custom('GBP', '9.00', '2026-10-12T12:00:00Z'),
  ];

  it('RF-M3-07 devuelve el último custom_rate de la moneda hasta el final del día, sin importar el orden', () => {
    expect(customRateOn(events, 'EUR', DATE, TZ)?.toFixed(2)).toBe('7.80');
    expect(customRateOn(events, 'EUR', '2026-10-12', TZ)?.toFixed(2)).toBe('7.50');
  });

  it('RF-M3-07 antes del primer evento devuelve el primero conocido', () => {
    expect(customRateOn(events, 'EUR', '2026-10-01', TZ)?.toFixed(2)).toBe('7.50');
  });

  it('RF-M3-07 devuelve null si la moneda no tiene ningún custom_rate', () => {
    expect(customRateOn(events, 'ARS', DATE, TZ)).toBeNull();
  });

  it('RF-M3-07 usa el día de Bolivia: 23:00 del día D entra y 00:00 del día D+1 no', () => {
    const evs = [
      custom('EUR', '7.50', '2026-10-01T12:00:00Z'),
      custom('EUR', '7.90', '2026-10-20T03:00:00Z'), // 23:00 del 19 en Bolivia
      custom('EUR', '8.10', '2026-10-20T04:00:00Z'), // 00:00 del 20 en Bolivia
    ];
    expect(customRateOn(evs, 'EUR', DATE, TZ)?.toFixed(2)).toBe('7.90');
  });

  it('RF-M3-07 ignora eventos que no son custom_rate', () => {
    const evs: FxEvent[] = [
      { kind: 'manual_usd_on', currencyCode: 'USD', reference: null, value: d('11.00'), effectiveAt: at('2026-10-11T12:00:00Z') },
      custom('EUR', '7.50', '2026-10-10T12:00:00Z'),
    ];
    expect(customRateOn(evs, 'USD', DATE, TZ)).toBeNull();
    expect(customRateOn(evs, 'EUR', DATE, TZ)?.toFixed(2)).toBe('7.50');
  });
});

describe('transferPrefill (RF-M3-07)', () => {
  it('RF-M3-07 Tasa precargada según la dirección: de Bs a $ se precarga la venta 10,30', () => {
    const rate = transferPrefill({
      from: 'BOB', to: 'USD', date: DATE, manual: null, parallel: PARALLEL, customRates: {},
    });
    expect(rate?.toFixed(2)).toBe('10.30');
    expect(amountInFrom(d('1000.00'), rate as Decimal, 'BOB').toFixed(2)).toBe('97.09');
  });

  it('RF-M3-07 de $ a Bs se precarga la compra 10,10', () => {
    const rate = transferPrefill({
      from: 'USD', to: 'BOB', date: DATE, manual: null, parallel: PARALLEL, customRates: {},
    });
    expect(rate?.toFixed(2)).toBe('10.10');
  });

  it('EC-M3-06 con el valor manual activo se precarga el valor manual, no el paralelo', () => {
    const rate = transferPrefill({
      from: 'BOB', to: 'USD', date: DATE, manual: d('9.50'), parallel: PARALLEL, customRates: {},
    });
    expect(rate?.toFixed(2)).toBe('9.50');
  });

  it('RF-M3-07 el valor manual también manda al vender dólares', () => {
    const rate = transferPrefill({
      from: 'USD', to: 'BOB', date: DATE, manual: d('9.50'), parallel: PARALLEL, customRates: {},
    });
    expect(rate?.toFixed(2)).toBe('9.50');
  });

  it('RF-M3-07 el valor manual funciona sin paralelo', () => {
    const rate = transferPrefill({
      from: 'BOB', to: 'USD', date: DATE, manual: d('9.50'), parallel: null, customRates: {},
    });
    expect(rate?.toFixed(2)).toBe('9.50');
  });

  it('RF-M3-07 sin manual ni paralelo con dólar devuelve null', () => {
    expect(transferPrefill({
      from: 'BOB', to: 'USD', date: DATE, manual: null, parallel: null, customRates: {},
    })).toBeNull();
  });

  it('RF-M3-07 sin dólar, entre BOB y una moneda agregada se usa su tasa manual', () => {
    const input = { date: DATE, manual: null, parallel: PARALLEL, customRates: { EUR: d('7.50') } };
    expect(transferPrefill({ ...input, from: 'BOB', to: 'EUR' })?.toFixed(2)).toBe('7.50');
    expect(transferPrefill({ ...input, from: 'EUR', to: 'BOB' })?.toFixed(2)).toBe('7.50');
  });

  it('RF-M3-07 entre dos monedas agregadas se usa la tasa cruzada a través de BOB', () => {
    const rate = transferPrefill({
      from: 'EUR', to: 'GBP', date: DATE, manual: null, parallel: null,
      customRates: { EUR: d('7.50'), GBP: d('9.00') },
    });
    expect(rate?.toFixed(2)).toBe('0.83'); // 7.50 / 9.00
  });

  it('RF-M3-07 entre USD y una moneda agregada: USD que se vende usa la compra; que se compra, la venta', () => {
    const customRates = { EUR: d('7.50') };
    const sell = transferPrefill({ from: 'USD', to: 'EUR', date: DATE, manual: null, parallel: PARALLEL, customRates });
    expect(sell?.toFixed(2)).toBe('1.35'); // 10.10 / 7.50
    const buy = transferPrefill({ from: 'EUR', to: 'USD', date: DATE, manual: null, parallel: PARALLEL, customRates });
    expect(buy?.toFixed(2)).toBe('0.73'); // 7.50 / 10.30
  });

  it('RF-M3-07 entre USD con valor manual y una moneda agregada usa el manual', () => {
    const rate = transferPrefill({
      from: 'USD', to: 'EUR', date: DATE, manual: d('10.00'), parallel: PARALLEL, customRates: { EUR: d('8.00') },
    });
    expect(rate?.toFixed(2)).toBe('1.25');
  });

  it('RF-M3-07 devuelve null si falta la tasa de una moneda agregada', () => {
    expect(transferPrefill({
      from: 'BOB', to: 'EUR', date: DATE, manual: null, parallel: PARALLEL, customRates: {},
    })).toBeNull();
    expect(transferPrefill({
      from: 'EUR', to: 'GBP', date: DATE, manual: null, parallel: null, customRates: { EUR: d('7.50') },
    })).toBeNull();
  });

  it('RF-M3-07 con la misma moneda de origen y destino devuelve null', () => {
    expect(transferPrefill({
      from: 'USD', to: 'USD', date: DATE, manual: d('9.50'), parallel: PARALLEL, customRates: {},
    })).toBeNull();
    expect(transferPrefill({
      from: 'BOB', to: 'BOB', date: DATE, manual: null, parallel: PARALLEL, customRates: {},
    })).toBeNull();
  });
});

describe('amountInFrom y rateFromAmounts (RF-M3-08)', () => {
  it('RF-M3-08 desde BOB el monto que llega es monto que sale ÷ tasa', () => {
    expect(amountInFrom(d('1000.00'), d('10.30'), 'BOB').toFixed(2)).toBe('97.09');
  });

  it('RF-M3-08 desde otra moneda el monto que llega es monto que sale × tasa', () => {
    expect(amountInFrom(d('100.00'), d('10.10'), 'USD').toFixed(2)).toBe('1010.00');
    expect(amountInFrom(d('100.00'), d('0.83'), 'EUR').toFixed(2)).toBe('83.00');
  });

  it('RN-06 amountInFrom redondea a 2 decimales con la mitad hacia arriba', () => {
    expect(amountInFrom(d('0.05'), d('10'), 'USD').toFixed(2)).toBe('0.50');
    expect(amountInFrom(d('1.00'), d('8'), 'BOB').toFixed(2)).toBe('0.13'); // 0.125
  });

  it('RF-M3-08 editar el monto que llega recalcula la tasa (desde BOB)', () => {
    expect(rateFromAmounts(d('1000.00'), d('97.09'), 'BOB').toFixed(2)).toBe('10.30');
  });

  it('RF-M3-08 editar el monto que llega recalcula la tasa (desde otra moneda)', () => {
    expect(rateFromAmounts(d('100.00'), d('1010.00'), 'USD').toFixed(2)).toBe('10.10');
  });

  it('RF-M3-08 la tasa recalculada reproduce el monto que llega con diferencia máxima de 0,01', () => {
    // montos pequeños: el plan solo garantiza la diferencia máxima para amountOut <= 2 (moneda de origen no BOB)
    const cases: Array<[string, string, string]> = [
      ['BOB', '1000.00', '97.09'],
      ['USD', '1.00', '10.13'],
      ['USD', '2.00', '20.27'],
      ['EUR', '2.00', '15.01'],
    ];
    for (const [from, out, inn] of cases) {
      const rate = rateFromAmounts(d(out), d(inn), from);
      const back = amountInFrom(d(out), rate, from);
      expect(back.minus(d(inn)).abs().lte('0.01')).toBe(true);
    }
  });
});
