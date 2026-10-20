import type { AccountDto } from '@finanzas/contracts';

import type { BalancePoint } from '../../application/ports/repositories.js';
import type { AccountsService } from '../../application/services/accounts.service.js';

/**
 * Net worth and breakdown of the active accounts (RF-M4-10). Without a rate needed to convert,
 * the amounts that depend on it are `null` (EC-M3-02).
 */
export type AccountsSummaryResponse = Awaited<ReturnType<AccountsService['summary']>>;

export interface AccountListResponse {
  items: AccountDto[];
  summary: AccountsSummaryResponse;
}

export interface BalanceSeriesResponse {
  points: { date: string; balance: string }[];
}

/** Builds the answers of `/api/accounts` (plan §4.4.2); amounts travel as decimal text (ADR-03). */
export const AccountsPresenter = {
  list(items: AccountDto[], summary: AccountsSummaryResponse): AccountListResponse {
    return { items, summary };
  },

  balanceSeries(points: readonly BalancePoint[]): BalanceSeriesResponse {
    return {
      points: points.map((point) => ({ date: point.date, balance: point.balance.toFixed(2) })),
    };
  },
};
