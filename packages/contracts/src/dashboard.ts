import { z } from 'zod';

import { AccountDto } from './accounts.js';
import { LocalDate, Money, Uuid } from './common.js';
import { TransactionDto } from './transactions.js';

const Month = z.string().regex(/^\d{4}-\d{2}$/);

export const DashboardQuery = z.object({ month: Month });
export type DashboardQuery = z.infer<typeof DashboardQuery>;

export const BudgetBarDto = z.object({
  categoryId: Uuid,
  name: z.string(),
  spent: Money,
  limit: Money,
  pct: z.number(),
});
export type BudgetBarDto = z.infer<typeof BudgetBarDto>;

export const UpcomingItemDto = z.object({
  id: Uuid,
  kind: z.string(),
  name: z.string(),
  amount: Money,
  dueDate: LocalDate,
});
export type UpcomingItemDto = z.infer<typeof UpcomingItemDto>;

export const DashboardDto = z.object({
  range: z.object({ firstMonth: Month, currentMonth: Month }),
  cards: z.object({
    income: Money,
    expense: Money,
    balance: Money,
    savingsRatePct: z.number().nullable(),
    variations: z.object({
      income: z.string().nullable(),
      expense: z.string().nullable(),
      balance: Money.nullable(),
      savingsRatePp: z.number().nullable(),
    }),
  }),
  budgets: z.array(BudgetBarDto).optional(),
  byCategory: z.object({
    top: z
      .array(z.object({ categoryId: Uuid, name: z.string(), amount: Money, pct: z.number() }))
      .max(5),
    others: z.object({ amount: Money, pct: z.number() }).nullable(),
  }),
  pace: z.object({
    current: z.array(z.object({ day: z.number(), cumulative: Money })),
    previous: z.array(z.object({ day: z.number(), cumulative: Money })),
  }),
  upcoming: z.array(UpcomingItemDto).optional(),
  balances: z.object({
    netWorth: z.object({ base: Money, other: Money.nullable() }),
    top: z.array(AccountDto).max(5),
    asOfToday: z.literal(true),
  }),
  recent: z.array(TransactionDto).max(5),
});
export type DashboardDto = z.infer<typeof DashboardDto>;

/** The answer of the Inicio: the blocks hidden by the user come without data (RF-M8-10). */
export const DashboardViewDto = DashboardDto.partial({
  byCategory: true,
  pace: true,
  balances: true,
  recent: true,
});
export type DashboardViewDto = z.infer<typeof DashboardViewDto>;
