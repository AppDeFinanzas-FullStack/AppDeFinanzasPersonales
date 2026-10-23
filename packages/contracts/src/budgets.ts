import { z } from 'zod';

import { IconKey, PaletteKey } from './catalogs.js';
import { Amount, CurrencyCode, LocalDate, Money } from './common.js';

const Thresholds = z
  .array(z.number().int().min(1).max(150))
  .max(3)
  .refine((t) => new Set(t).size === t.length)
  .transform((t) => [...t].sort((a, b) => a - b));
const StartDay = z.number().int().min(1).max(28);
const DefaultAction = z.enum(['discard', 'carry']);

export const CreateBudgetInput = z.object({
  id: z.uuid(),
  scope: z.enum(['category', 'general']),
  categoryId: z.uuid().optional(),
  amount: Amount,
  currencyCode: CurrencyCode,
  startDay: StartDay.default(1),
  defaultAction: DefaultAction.default('discard'),
  thresholds: Thresholds.default([80, 100]),
});
export type CreateBudgetInput = z.infer<typeof CreateBudgetInput>;

export const UpdateBudgetInput = z
  .object({
    amount: Amount,
    defaultAction: DefaultAction,
    thresholds: Thresholds,
    startDay: StartDay,
  })
  .partial()
  .strict();
export type UpdateBudgetInput = z.infer<typeof UpdateBudgetInput>;

export const DecisionInput = z.discriminatedUnion('result', [
  z.object({
    result: z.literal('surplus'),
    carry: Money,
    discard: Money,
    toGoal: z
      .object({
        goalId: z.uuid(),
        accountId: z.uuid(),
        amount: Amount,
        mode: z.enum(['earmark', 'transfer']),
      })
      .optional(),
  }),
  z.object({ result: z.literal('deficit'), mode: z.enum(['carry', 'absorb']) }),
]);
export type DecisionInput = z.infer<typeof DecisionInput>;

export const BUDGET_STATUSES = ['active', 'paused', 'finalizing', 'finalized'] as const;
export const BudgetStatus = z.enum(BUDGET_STATUSES);
export type BudgetStatus = z.infer<typeof BudgetStatus>;

export const BudgetDto = z.object({
  id: z.uuid(),
  scope: z.enum(['category', 'general']),
  category: z
    .object({ id: z.uuid(), name: z.string(), icon: IconKey, color: PaletteKey })
    .optional(),
  amount: Money,
  currencyCode: CurrencyCode,
  startDay: z.number().int(),
  nextStartDay: z.number().int().optional(),
  defaultAction: DefaultAction,
  thresholds: z.array(z.number().int()),
  status: BudgetStatus,
  current: z
    .object({
      periodId: z.uuid(),
      start: LocalDate,
      end: LocalDate,
      spent: Money,
      available: Money,
      carryover: Money,
      lateAdjustments: z.array(z.object({ sourceLabel: z.string(), amount: Money })),
      todayShouldBe: Money,
      pace: z.object({
        kind: z.enum(['daily', 'over', 'exceeded']),
        amount: Money,
        days: z.number().int().optional(),
      }),
    })
    .optional(),
  pendingClose: z
    .object({ periodId: z.uuid(), label: z.string(), result: Money, deadline: LocalDate })
    .optional(),
  childrenExceedParent: z.boolean(),
});
export type BudgetDto = z.infer<typeof BudgetDto>;
