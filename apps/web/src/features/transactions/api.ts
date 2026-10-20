import { CurrencyCode, LocalDate, Money, TransactionKind, Uuid } from '@finanzas/contracts';
import { z } from 'zod';

import type { Endpoint } from '@/lib/api-client';

/**
 * A movement of the list (`TransactionDto`, plan §4.6.1). Without a rate to convert it,
 * `amountInBase` comes as `null` (EC-M3-02).
 */
export const TransactionItem = z.object({
  id: Uuid,
  kind: TransactionKind,
  date: LocalDate,
  note: z.string().nullable(),
  category: z.object({ id: Uuid, name: z.string() }).nullable().optional(),
  entries: z.array(z.object({ accountId: Uuid, amount: Money, currencyCode: CurrencyCode })),
  origin: z.string(),
  originId: z.string().nullable().optional(),
  linkedLocked: z.boolean(),
  recurringLabel: z.string().nullable().optional(),
  beforeInitialBalance: z.boolean(),
  rateUsdBob: z.string().nullable().optional(),
  rateCurBob: z.string(),
  declaredRate: z.string().nullable().optional(),
  amountInBase: Money.nullable(),
  createdAt: z.string(),
});
export type TransactionItem = z.infer<typeof TransactionItem>;

/** Income minus expense of a day in the base currency, without what RN-02 leaves out. */
const DayNet = z.object({ date: LocalDate, net: Money });
export type DayNet = z.infer<typeof DayNet>;

const TransactionPage = z.object({
  items: z.array(TransactionItem),
  nextCursor: z.string().nullable(),
  dayNets: z.array(DayNet),
});
export type TransactionPage = z.infer<typeof TransactionPage>;

const TransactionTotals = z.object({ income: Money, expense: Money, net: Money });
export type TransactionTotals = z.infer<typeof TransactionTotals>;

/** The filters of the list as the API takes them (`ListQuery`, plan §4.6.1). */
export const TransactionFilters = z.object({
  month: z.string().optional(),
  from: LocalDate.optional(),
  to: LocalDate.optional(),
  accountId: Uuid.optional(),
  categoryId: Uuid.optional(),
  kind: TransactionKind.optional(),
  q: z.string().optional(),
});
export type TransactionFilters = z.infer<typeof TransactionFilters>;

const ListInput = TransactionFilters.extend({
  cursor: z.string().optional(),
  limit: z.number().int().optional(),
});

export const listTransactionsEndpoint: Endpoint<z.infer<typeof ListInput>, TransactionPage> = {
  method: 'GET',
  path: '/api/transactions',
  input: ListInput,
  output: TransactionPage,
};

export const transactionsSummaryEndpoint: Endpoint<TransactionFilters, TransactionTotals> = {
  method: 'GET',
  path: '/api/transactions/summary',
  input: TransactionFilters,
  output: TransactionTotals,
};
