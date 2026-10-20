import type { Decimal } from 'decimal.js';

import type { LocalDate } from './clock.js';

/** SOURCE_ERROR covers network errors, non-200 HTTP, JSON-RPC errors and isError results. */
export type RateFailure = 'TIMEOUT' | 'INVALID_VALUE' | 'SOURCE_ERROR';

export type RateResult<T> = { ok: true; value: T } | { ok: false; reason: RateFailure };

/** bid/ask are already classified (bid <= ask); null when the source values are not valid. */
export interface ParallelQuote {
  median: Decimal;
  bid: Decimal | null;
  ask: Decimal | null;
  observedAt: Date;
}

export interface OfficialQuote {
  value: Decimal;
  /** Date the rate takes effect, when the source states it. */
  effectiveDate: LocalDate | null;
  observedAt: Date;
}

/** A failing source never throws: it returns a result. */
export interface RatesGateway {
  fetchParallel(): Promise<RateResult<ParallelQuote>>;
  fetchOfficial(): Promise<RateResult<OfficialQuote>>;
  fetchParallelOn(date: LocalDate): Promise<RateResult<{ median: Decimal; date: LocalDate }>>;
}
