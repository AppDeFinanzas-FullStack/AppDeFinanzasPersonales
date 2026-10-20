import { Decimal } from 'decimal.js';
import { describe, expect, it } from 'vitest';
import { resolveUsdRate } from '../src/fx.js';
import type { FxEvent, MarketSeries } from '../src/fx.js';

const TZ = 'America/La_Paz';
const d = (v: string): Decimal => new Decimal(v);
const at = (iso: string): Date => new Date(iso);
const NOW = at('2026-10-19T15:00:00Z'); // 11:00 en Bolivia, 2026-10-19

const emptySeries = (): MarketSeries => ({
  parallel_bid: [],
  parallel_ask: [],
  parallel_median: [],
  official: [],
});

const series = (over: Partial<MarketSeries>): MarketSeries => ({ ...emptySeries(), ...over });

const manualOn = (value: string, iso: string): FxEvent => ({
  kind: 'manual_usd_on',
  currencyCode: 'USD',
  reference: null,
  value: d(value),
  effectiveAt: at(iso),
});
const manualOff = (iso: string): FxEvent => ({
  kind: 'manual_usd_off',
  currencyCode: 'USD',
  reference: null,
  value: null,
  effectiveAt: at(iso),
});
const refSet = (reference: FxEvent['reference'], iso: string): FxEvent => ({
  kind: 'reference_set',
  currencyCode: null,
  reference,
  value: null,
  effectiveAt: at(iso),
});

const run = (events: FxEvent[], s: MarketSeries, date: string): Decimal | null =>
  resolveUsdRate({ events, series: s, date, tz: TZ, now: NOW });

describe('resolveUsdRate', () => {
  it('RF-M3-03 el valor manual activo tiene prioridad sobre cualquier referencia (hoy)', () => {
    const s = series({
      parallel_median: [{ rateDate: '2026-10-19', value: d('10.20') }],
      official: [{ rateDate: '2026-10-19', value: d('6.96') }],
    });
    const events = [refSet('official', '2026-10-01T12:00:00Z'), manualOn('11.50', '2026-10-10T12:00:00Z')];
    expect(run(events, s, '2026-10-19')?.toFixed(2)).toBe('11.50');
  });

  it('RF-M3-03 sin manual ni elección la referencia por defecto es la mediana del paralelo', () => {
    const s = series({
      parallel_bid: [{ rateDate: '2026-10-19', value: d('10.10') }],
      parallel_ask: [{ rateDate: '2026-10-19', value: d('10.30') }],
      parallel_median: [{ rateDate: '2026-10-19', value: d('10.20') }],
      official: [{ rateDate: '2026-10-19', value: d('6.96') }],
    });
    expect(run([], s, '2026-10-19')?.toFixed(2)).toBe('10.20');
  });

  it('RF-M3-03 con el manual apagado se usa la referencia elegida', () => {
    const s = series({ official: [{ rateDate: '2026-10-19', value: d('6.96') }] });
    const events = [
      refSet('official', '2026-10-01T12:00:00Z'),
      manualOn('11.50', '2026-10-10T12:00:00Z'),
      manualOff('2026-10-12T12:00:00Z'),
    ];
    expect(run(events, s, '2026-10-19')?.toFixed(2)).toBe('6.96');
  });

  it('RF-M3-03 los eventos sin ordenar se resuelven por effectiveAt', () => {
    const events = [manualOff('2026-10-12T12:00:00Z'), manualOn('11.50', '2026-10-10T12:00:00Z')];
    const s = series({ parallel_median: [{ rateDate: '2026-10-19', value: d('10.20') }] });
    expect(run(events, s, '2026-10-19')?.toFixed(2)).toBe('10.20');
  });

  it('RF-M3-06 con fecha pasada se usa el valor manual que el usuario tenía ese día', () => {
    const s = series({ parallel_median: [{ rateDate: '2026-10-12', value: d('10.00') }] });
    const events = [manualOn('11.00', '2026-10-10T12:00:00Z'), manualOn('12.00', '2026-10-15T12:00:00Z')];
    expect(run(events, s, '2026-10-12')?.toFixed(2)).toBe('11.00');
  });

  it('RF-M3-06 con fecha pasada se usa la referencia que el usuario tenía ese día', () => {
    const s = series({
      parallel_median: [{ rateDate: '2026-10-12', value: d('10.00') }],
      official: [{ rateDate: '2026-10-12', value: d('6.96') }, { rateDate: '2026-10-16', value: d('6.96') }],
    });
    const events = [refSet('official', '2026-10-15T12:00:00Z')];
    expect(run(events, s, '2026-10-12')?.toFixed(2)).toBe('10.00');
    expect(run(events, s, '2026-10-16')?.toFixed(2)).toBe('6.96');
  });

  it('RF-M3-06 un manual apagado ese día ya no aplica al final del día', () => {
    const s = series({ parallel_median: [{ rateDate: '2026-10-12', value: d('10.00') }] });
    const events = [manualOn('11.00', '2026-10-10T12:00:00Z'), manualOff('2026-10-12T20:00:00Z')];
    expect(run(events, s, '2026-10-12')?.toFixed(2)).toBe('10.00');
  });

  it('RF-M3-06 un evento después de medianoche de Bolivia no afecta al día anterior', () => {
    // 2026-10-13T03:00Z = 23:00 del 12 en Bolivia (cuenta); 2026-10-13T04:00Z = 00:00 del 13 (no cuenta)
    const s = series({ parallel_median: [{ rateDate: '2026-10-12', value: d('10.00') }] });
    expect(run([manualOn('11.00', '2026-10-13T03:00:00Z')], s, '2026-10-12')?.toFixed(2)).toBe('11.00');
    expect(run([manualOn('11.00', '2026-10-13T04:00:00Z')], s, '2026-10-12')?.toFixed(2)).toBe('10.00');
  });

  it('RF-M3-13 un día sin compra usa la mediana de ese día', () => {
    const s = series({
      parallel_bid: [{ rateDate: '2026-10-10', value: d('10.00') }],
      parallel_ask: [{ rateDate: '2026-10-12', value: d('10.40') }],
      parallel_median: [{ rateDate: '2026-10-12', value: d('10.25') }],
    });
    const events = [refSet('parallel_bid', '2026-10-01T12:00:00Z')];
    expect(run(events, s, '2026-10-12')?.toFixed(2)).toBe('10.25');
  });

  it('RF-M3-13 un día sin venta usa la mediana de ese día', () => {
    const s = series({
      parallel_bid: [{ rateDate: '2026-10-12', value: d('10.10') }],
      parallel_median: [{ rateDate: '2026-10-12', value: d('10.25') }],
    });
    const events = [refSet('parallel_ask', '2026-10-01T12:00:00Z')];
    expect(run(events, s, '2026-10-12')?.toFixed(2)).toBe('10.25');
  });

  it('RF-M3-13 un día con compra usa la compra y no la mediana', () => {
    const s = series({
      parallel_bid: [{ rateDate: '2026-10-12', value: d('10.10') }],
      parallel_median: [{ rateDate: '2026-10-12', value: d('10.25') }],
    });
    const events = [refSet('parallel_bid', '2026-10-01T12:00:00Z')];
    expect(run(events, s, '2026-10-12')?.toFixed(2)).toBe('10.10');
  });

  it('EC-M3-03 un día sin datos usa el del día anterior más cercano', () => {
    const s = series({
      parallel_median: [
        { rateDate: '2026-10-05', value: d('9.90') },
        { rateDate: '2026-10-10', value: d('10.00') },
        { rateDate: '2026-10-14', value: d('10.50') },
      ],
    });
    expect(run([], s, '2026-10-12')?.toFixed(2)).toBe('10.00');
  });

  it('EC-M3-03 la serie sin ordenar da el mismo resultado', () => {
    const s = series({
      parallel_median: [
        { rateDate: '2026-10-14', value: d('10.50') },
        { rateDate: '2026-10-05', value: d('9.90') },
        { rateDate: '2026-10-10', value: d('10.00') },
      ],
    });
    expect(run([], s, '2026-10-12')?.toFixed(2)).toBe('10.00');
  });

  it('EC-M3-03 antes del primer dato se usa el primer valor conocido', () => {
    const s = series({
      parallel_median: [
        { rateDate: '2026-10-10', value: d('10.00') },
        { rateDate: '2026-10-14', value: d('10.50') },
      ],
    });
    expect(run([], s, '2026-10-01')?.toFixed(2)).toBe('10.00');
  });

  it('EC-M3-03 hoy sin dato del día usa el anterior más cercano', () => {
    const s = series({ parallel_median: [{ rateDate: '2026-10-17', value: d('10.10') }] });
    expect(run([], s, '2026-10-19')?.toFixed(2)).toBe('10.10');
  });

  it('TASK-079 sin ninguna tasa devuelve null', () => {
    expect(run([], emptySeries(), '2026-10-19')).toBeNull();
    expect(run([], emptySeries(), '2026-10-01')).toBeNull();
  });

  it('TASK-079 con referencia elegida sin datos y sin manual devuelve null', () => {
    const s = series({ parallel_median: [{ rateDate: '2026-10-19', value: d('10.20') }] });
    expect(run([refSet('official', '2026-10-01T12:00:00Z')], s, '2026-10-19')).toBeNull();
  });

  it('RN-04 el manual activo se devuelve aunque no haya serie de mercado', () => {
    const r = run([manualOn('11.50', '2026-10-10T12:00:00Z')], emptySeries(), '2026-10-19');
    expect(r?.toFixed(2)).toBe('11.50');
  });

  it('RN-04 cambios posteriores del usuario no alteran la tasa de una fecha pasada', () => {
    const s = series({ parallel_median: [{ rateDate: '2026-10-12', value: d('10.00') }] });
    const before = run([], s, '2026-10-12');
    const after = run([manualOn('13.00', '2026-10-18T12:00:00Z')], s, '2026-10-12');
    expect(after?.toFixed(2)).toBe(before?.toFixed(2));
  });
});
