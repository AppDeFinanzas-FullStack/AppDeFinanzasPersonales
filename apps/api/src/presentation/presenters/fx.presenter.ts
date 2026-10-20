import type { RatesCurrentDto } from '@finanzas/contracts';

import type { MarketRateRow } from '../../application/ports/repositories.js';

/** One day of a rate history: the date and its value as decimal text (ADR-03). */
export interface RateHistoryPointDto {
  date: string;
  value: string;
}

export interface RateHistoryDto {
  points: RateHistoryPointDto[];
}

/** Builds the answers of `/api/rates/*` (plan §4.3.2). */
export const FxPresenter = {
  current(rates: RatesCurrentDto): RatesCurrentDto {
    return rates;
  },

  history(rows: readonly MarketRateRow[]): RateHistoryDto {
    return {
      points: rows.map((row) => ({ date: row.rateDate, value: row.value.toFixed(2) })),
    };
  },
};
