import type { Decimal } from 'decimal.js';
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
