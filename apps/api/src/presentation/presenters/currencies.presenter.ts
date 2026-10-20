import type { CurrencyDto } from '@finanzas/contracts';

import type { CurrencyView } from '../../application/services/currencies.service.js';

export interface CurrencyListDto {
  items: CurrencyDto[];
}

/** Builds the answers of `/api/currencies` (plan §4.3.2); rates travel as decimal text (ADR-03). */
export const CurrenciesPresenter = {
  toDto(currency: CurrencyView): CurrencyDto {
    return { code: currency.code, symbol: currency.symbol, rate: currency.rate.toFixed(2) };
  },

  list(currencies: readonly CurrencyView[]): CurrencyListDto {
    return { items: currencies.map((currency) => CurrenciesPresenter.toDto(currency)) };
  },
};
