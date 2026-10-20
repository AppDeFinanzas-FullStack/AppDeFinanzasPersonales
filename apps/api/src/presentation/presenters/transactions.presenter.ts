import type { TransactionDto } from '@finanzas/contracts';
import type { Decimal } from 'decimal.js';

import type { LedgerTotals } from '../../application/ports/repositories.js';
import type {
  BatchResult,
  CreateTransactionResult,
  DeleteTransactionResult,
  DescribedTransaction,
  DescribedTransactionDetail,
  TransactionListPage,
} from '../../application/services/transactions.service.js';

/**
 * A movement of the answers (`TransactionDto`, plan §4.6.1). Without a rate to convert it,
 * `amountInBase` is `null` (EC-M3-02).
 */
export type TransactionResponse = Omit<TransactionDto, 'amountInBase' | 'fee'> & {
  amountInBase: string | null;
  fee?: TransactionResponse;
};

export interface CreatedTransactionResponse {
  transaction: TransactionResponse;
  /** `null` when the movement already existed with the same id and data (ADR-11). */
  undoToken: string | null;
}

export interface TransactionPageResponse {
  items: TransactionResponse[];
  nextCursor: string | null;
  dayNets: { date: string; net: string }[];
}

export interface TransactionTotalsResponse {
  income: string;
  expense: string;
  net: string;
}

export interface BatchResponse {
  processed: number;
  skipped: number;
  undoToken: string | null;
}

const money = (value: Decimal): string => value.toFixed(2);

const moneyOrNull = (value: Decimal | null): string | null =>
  value === null ? null : value.toFixed(2);

function movementOf(movement: DescribedTransaction): TransactionResponse {
  return {
    id: movement.id,
    kind: movement.kind,
    date: movement.date,
    note: movement.note,
    category: movement.category,
    entries: movement.entries.map((entry) => ({
      accountId: entry.accountId,
      amount: money(entry.amount),
      currencyCode: entry.currencyCode,
    })),
    origin: movement.origin,
    originId: movement.originId,
    linkedLocked: movement.linkedLocked,
    recurringLabel: movement.recurringLabel,
    beforeInitialBalance: movement.beforeInitialBalance,
    rateUsdBob: moneyOrNull(movement.rateUsdBob),
    rateCurBob: money(movement.rateCurBob),
    declaredRate: moneyOrNull(movement.declaredRate),
    amountInBase: moneyOrNull(movement.amountInBase),
    createdAt: movement.createdAt.toISOString(),
  };
}

/** Builds the answers of `/api/transactions` (plan §4.6.2); amounts travel as decimal text (ADR-03). */
export const TransactionsPresenter = {
  transaction(movement: DescribedTransactionDetail): TransactionResponse {
    const response = movementOf(movement);
    return movement.fee === null ? response : { ...response, fee: movementOf(movement.fee) };
  },

  created(result: CreateTransactionResult): CreatedTransactionResponse {
    return {
      transaction: TransactionsPresenter.transaction(result.transaction),
      undoToken: result.undoToken,
    };
  },

  page(page: TransactionListPage): TransactionPageResponse {
    return {
      items: page.items.map(movementOf),
      nextCursor: page.nextCursor,
      dayNets: page.dayNets.map((day) => ({ date: day.date, net: money(day.net) })),
    };
  },

  totals(totals: LedgerTotals): TransactionTotalsResponse {
    return { income: money(totals.income), expense: money(totals.expense), net: money(totals.net) };
  },

  deleted(result: DeleteTransactionResult): { undoToken: string } {
    return { undoToken: result.undoToken };
  },

  batch(result: BatchResult): BatchResponse {
    return { processed: result.processed, skipped: result.skipped, undoToken: result.undoToken };
  },
};
