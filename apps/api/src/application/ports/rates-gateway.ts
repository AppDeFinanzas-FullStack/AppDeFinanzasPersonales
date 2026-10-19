import type { Decimal } from 'decimal.js';

export interface RateQuote {
  /** Bolivianos per US dollar. */
  rate: Decimal;
  fetchedAt: Date;
}

export interface RatesGateway {
  fetchParallel(): Promise<RateQuote>;
  fetchOfficial(): Promise<RateQuote>;
}
