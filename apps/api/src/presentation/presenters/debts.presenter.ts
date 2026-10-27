import type { DebtDto, DebtsSummaryDto } from '@finanzas/contracts';

import type { DebtsListResult } from '../../application/services/debts.service.js';

/** Builds the answers of `/api/debts` (plan §4.13.2). Money travels as text (ADR-03). */
export const DebtsPresenter = {
  one(debt: DebtDto): DebtDto {
    return debt;
  },

  list(result: DebtsListResult): { debts: DebtDto[]; summary: DebtsSummaryDto } {
    return { debts: result.debts, summary: result.summary };
  },
};
