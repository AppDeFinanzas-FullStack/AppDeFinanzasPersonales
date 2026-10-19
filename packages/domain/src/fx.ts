import type { Decimal } from 'decimal.js';
import { startOfDayInstant } from './dates.js';
import type { Instant, LocalDate } from './dates.js';
import { round2 } from './money.js';

/** Bid (compra) is the lower value and ask (venta) the higher, whatever the source calls them (ADR-06). */
export function classifyBidAsk(a: Decimal, b: Decimal): { bid: Decimal; ask: Decimal } {
  return a.lessThanOrEqualTo(b) ? { bid: a, ask: b } : { bid: b, ask: a };
}

/** Gap = (parallel - official) / official, as a percentage and in Bs (RF-M3-12). */
export function gap(parallel: Decimal, official: Decimal): { pct: Decimal; bs: Decimal } {
  const diff = parallel.minus(official);
  const pct = round2(diff.dividedBy(official).times(100));
  const bs = round2(diff);
  return { pct: pct.isZero() ? pct.abs() : pct, bs: bs.isZero() ? bs.abs() : bs };
}

export type UsdReference = 'parallel_bid' | 'parallel_ask' | 'parallel_median' | 'official';

export type FxEvent = {
  kind: 'reference_set' | 'manual_usd_on' | 'manual_usd_off' | 'custom_rate';
  currencyCode: string | null;
  reference: UsdReference | null;
  value: Decimal | null;
  effectiveAt: Instant;
};

export type MarketSeries = Record<UsdReference, ReadonlyArray<{ rateDate: LocalDate; value: Decimal }>>;

type SeriesRow = { rateDate: LocalDate; value: Decimal };

function nextDay(date: LocalDate): LocalDate {
  const [y, m, d] = date.split('-').map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d + 1)).toISOString().slice(0, 10);
}

function valueForDay(kind: UsdReference, series: MarketSeries, date: LocalDate): Decimal | null {
  const own: ReadonlyArray<SeriesRow> = series[kind];
  const median: ReadonlyArray<SeriesRow> =
    kind === 'parallel_bid' || kind === 'parallel_ask' ? series.parallel_median : [];
  const byDay = new Map<LocalDate, Decimal>();
  for (const row of median) byDay.set(row.rateDate, row.value);
  for (const row of own) byDay.set(row.rateDate, row.value);
  const days = [...byDay.keys()].sort();
  if (days.length === 0) return null;
  let chosen = days[0] as LocalDate;
  for (const day of days) {
    if (day <= date) chosen = day;
  }
  return byDay.get(chosen) ?? null;
}

/** USD-Bs rate for a date: the manual value if active, else the reference in use (RF-M3-03, RF-M3-06, RF-M3-13). */
export function resolveUsdRate(input: {
  events: FxEvent[];
  series: MarketSeries;
  date: LocalDate;
  tz: string;
  now: Instant;
}): Decimal | null {
  const limit = startOfDayInstant(nextDay(input.date), input.tz).getTime();
  const active = input.events
    .filter((e) => e.effectiveAt.getTime() < limit)
    .sort((a, b) => a.effectiveAt.getTime() - b.effectiveAt.getTime());
  let manual: Decimal | null = null;
  let reference: UsdReference = 'parallel_median';
  for (const e of active) {
    if (e.kind === 'manual_usd_on') manual = e.value;
    else if (e.kind === 'manual_usd_off') manual = null;
    else if (e.kind === 'reference_set' && e.reference) reference = e.reference;
  }
  if (manual) return manual;
  return valueForDay(reference, input.series, input.date);
}
