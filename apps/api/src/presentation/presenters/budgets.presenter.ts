import type { BudgetDto } from '@finanzas/contracts';

import type { BudgetDetail } from '../../application/services/budgets.service.js';

/** Builds the answers of `/api/budgets` (plan §4.11.2). Money travels as text (ADR-03). */
export const BudgetsPresenter = {
  one(budget: BudgetDto): BudgetDto {
    return budget;
  },

  list(budgets: BudgetDto[]): { items: BudgetDto[] } {
    return { items: budgets };
  },

  detail(budget: BudgetDetail): BudgetDetail {
    return budget;
  },
};
