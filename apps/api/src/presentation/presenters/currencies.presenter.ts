import type { CurrencyDto, CurrencyListItemDto } from '@finanzas/contracts';

import type { CurrencyView } from '../../application/services/currencies.service.js';

export interface CurrencyListDto {
  items: CurrencyListItemDto[];
}

/** Builds the answers of `/api/currencies` (plan §4.3.2); rates travel as decimal text (ADR-03). */
export const CurrenciesPresenter = {
  toDto(currency: CurrencyView): CurrencyDto {
    return { code: currency.code, symbol: currency.symbol, rate: currency.rate.toFixed(2) };
  },

  /** A listed currency also says whether it is active, so Ajustes offers only the active ones. */
  toListItem(currency: CurrencyView): CurrencyListItemDto {
    return { ...CurrenciesPresenter.toDto(currency), status: currency.status };
  },

  list(currencies: readonly CurrencyView[]): CurrencyListDto {
    return { items: currencies.map((currency) => CurrenciesPresenter.toListItem(currency)) };
  },
};
