import type { DashboardView } from '../../application/services/dashboard.service.js';

import { TransactionsPresenter, type TransactionResponse } from './transactions.presenter.js';

export type DashboardResponse = Omit<DashboardView, 'recent'> & { recent?: TransactionResponse[] };

/** Builds the answer of `GET /api/dashboard` (plan §4.8.2); amounts travel as decimal text (ADR-03). */
export const DashboardPresenter = {
  view(view: DashboardView): DashboardResponse {
    const { recent, ...blocks } = view;
    if (recent === undefined) {
      return blocks;
    }
    const page = TransactionsPresenter.page({ items: recent, nextCursor: null, dayNets: [] });
    return { ...blocks, recent: page.items };
  },
};
