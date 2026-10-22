import { z } from 'zod';

import { IconKey, PaletteKey } from './catalogs.js';
import { Amount, CurrencyCode, LocalDate, Money, TrimmedName } from './common.js';

export const CreateGoalInput = z.object({
  id: z.uuid(),
  name: TrimmedName(1, 40),
  target: Amount,
  currencyCode: CurrencyCode,
  targetDate: LocalDate.optional(),
  icon: IconKey,
  color: PaletteKey,
  dedicatedAccountId: z.uuid().optional(),
});
export type CreateGoalInput = z.infer<typeof CreateGoalInput>;

export const UpdateGoalInput = CreateGoalInput.omit({
  id: true,
  dedicatedAccountId: true,
}).partial();
export type UpdateGoalInput = z.infer<typeof UpdateGoalInput>;

export const EarmarkInput = z.object({
  id: z.uuid(),
  accountId: z.uuid(),
  amount: Amount,
});
export type EarmarkInput = z.infer<typeof EarmarkInput>;

export const ReleaseInput = z.object({
  accountId: z.uuid(),
  amount: Amount,
});
export type ReleaseInput = z.infer<typeof ReleaseInput>;

export const DedicateInput = z.object({ accountId: z.uuid() });
export type DedicateInput = z.infer<typeof DedicateInput>;

export const GOAL_STATUSES = ['in_progress', 'achieved', 'overdue', 'archived'] as const;
export const GoalStatus = z.enum(GOAL_STATUSES);
export type GoalStatus = z.infer<typeof GoalStatus>;

export const GoalDto = z.object({
  id: z.uuid(),
  name: z.string(),
  target: Money,
  currencyCode: CurrencyCode,
  targetDate: LocalDate.optional(),
  icon: IconKey,
  color: PaletteKey,
  status: GoalStatus,
  progress: Money,
  pct: z.number(),
  byAccount: z.array(
    z.object({
      accountId: z.uuid(),
      name: z.string(),
      amount: Money,
      dedicated: z.boolean(),
    }),
  ),
  suggested: z.object({
    kind: z.enum(['monthly', 'this_month', 'calculator', 'pick_new_date', 'none']),
    amount: Money.optional(),
    untilMonth: z.string().optional(),
  }),
  dedicatedAccount: z.object({ id: z.uuid(), name: z.string() }).optional(),
  firstAchievement: z.boolean(),
});
export type GoalDto = z.infer<typeof GoalDto>;
