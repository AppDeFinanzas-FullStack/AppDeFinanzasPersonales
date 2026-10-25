import { z } from 'zod';

import { Amount, LocalDate, Note, Rate, TrimmedName, Uuid } from './common.js';

const EarmarkWithdrawals = z.array(z.object({ goalId: Uuid, accountId: Uuid, amount: Amount }));

/** Daily, weekly (a single weekday), monthly (fixed day) or yearly (RF-M14-01). */
export const RuleFrequency = z.discriminatedUnion('type', [
  z.object({ type: z.literal('daily') }),
  z.object({ type: z.literal('weekly'), weekday: z.number().int().min(0).max(6) }),
  z.object({ type: z.literal('monthly'), day: z.number().int().min(1).max(31) }),
  z.object({
    type: z.literal('yearly'),
    month: z.number().int().min(1).max(12),
    day: z.number().int().min(1).max(31),
  }),
]);
export type RuleFrequency = z.infer<typeof RuleFrequency>;

export const RuleEnd = z.discriminatedUnion('type', [
  z.object({ type: z.literal('none') }),
  z.object({ type: z.literal('until'), date: LocalDate }),
  z.object({ type: z.literal('count'), count: z.number().int().min(1).max(999) }),
]);
export type RuleEnd = z.infer<typeof RuleEnd>;

export const RuleKind = z.enum(['expense', 'income', 'transfer']);
export type RuleKind = z.infer<typeof RuleKind>;

export const RuleMode = z.enum(['auto', 'confirm']);
export type RuleMode = z.infer<typeof RuleMode>;

const RuleFields = z.object({
  id: Uuid,
  name: TrimmedName(1, 40),
  kind: RuleKind,
  amount: Amount.optional(),
  accountId: Uuid,
  destAccountId: Uuid.optional(),
  categoryId: Uuid.optional(),
  note: Note.optional(),
  frequency: RuleFrequency,
  // The "today or later" check needs the user's time zone, so the application layer does it (RF-M14-03).
  startDate: LocalDate,
  end: RuleEnd,
  mode: RuleMode,
});

/** The amount is required in automatic mode and optional in confirmation mode (RF-M14-14). */
export const CreateRuleInput = RuleFields.refine(
  (r) => r.amount !== undefined || r.mode === 'confirm',
  { message: 'AMOUNT_REQUIRED_FOR_AUTO' },
);
export type CreateRuleInput = z.infer<typeof CreateRuleInput>;

/** Editing only affects future occurrences (RF-M14-10). */
export const UpdateRuleInput = RuleFields.omit({ id: true }).partial();
export type UpdateRuleInput = z.infer<typeof UpdateRuleInput>;

export const ConfirmOccurrenceInput = z.object({
  transactionId: Uuid,
  amount: Amount.optional(),
  date: LocalDate.optional(),
  rateUsdBob: Rate.optional(),
  declaredRate: Rate.optional(),
  accountId: Uuid.optional(),
  categoryId: Uuid.optional(),
  earmarkWithdrawals: EarmarkWithdrawals.optional(),
});
export type ConfirmOccurrenceInput = z.infer<typeof ConfirmOccurrenceInput>;

/** The skipped dates the user chooses to register when resuming a rule (RF-M14-09). */
export const ResumeInput = z.object({ registerDates: z.array(LocalDate) });
export type ResumeInput = z.infer<typeof ResumeInput>;

export const RuleStatus = z.enum(['active', 'paused', 'finished']);
export type RuleStatus = z.infer<typeof RuleStatus>;

export interface RuleDto {
  id: string;
  name: string;
  kind: RuleKind;
  /** Absent when the amount is "to be defined" (RF-M14-14). */
  amount?: string;
  currency: string;
  accountId: string;
  destAccountId?: string;
  categoryId?: string;
  note?: string;
  frequency: RuleFrequency;
  startDate: string;
  end: RuleEnd;
  mode: RuleMode;
  status: RuleStatus;
  nextDate: string | null;
  /** The next 3 dates (RF-M14-13). */
  next3: string[];
  /** "Cuota X de N" when the end is by count (RF-M14-13). */
  installment: { current: number; total: number } | null;
}

export interface OccurrenceDto {
  /** The pending transaction to confirm with `ConfirmOccurrenceInput`. */
  transactionId: string;
  ruleId: string;
  ruleName: string;
  date: string;
  amount?: string;
  currency: string;
  accountId: string;
  categoryId?: string;
}

export interface UpcomingDto {
  ruleId: string;
  ruleName: string;
  date: string;
  amount?: string;
  currency: string;
}

export interface RecurringOverviewDto {
  rules: RuleDto[];
  /** "Pendientes de confirmar" (RF-M14-13). */
  pending: OccurrenceDto[];
  /** "Próximos vencimientos" for the next 30 days (RF-M14-13). */
  upcoming30: UpcomingDto[];
}
