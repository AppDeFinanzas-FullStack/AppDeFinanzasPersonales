import { Decimal } from 'decimal.js';
import { z } from 'zod';

import { Amount, CurrencyCode, LocalDate, Money, Note, Rate, Uuid } from './common.js';

const MIN_INTEREST_RATE = '0.01';
const MAX_INTEREST_RATE = '100';
const INTEREST_RATE_FORMAT = /^\d{1,3}(\.\d{1,4})?$/;

export const DebtDirection = z.enum(['i_owe', 'owed_to_me']);
export type DebtDirection = z.infer<typeof DebtDirection>;

export const InterestPeriod = z.enum(['monthly', 'yearly']);
export type InterestPeriod = z.infer<typeof InterestPeriod>;

export const DebtStatus = z.enum(['active', 'overdue', 'paid', 'forgiven']);
export type DebtStatus = z.infer<typeof DebtStatus>;

/** The interest rate in percent: 0.01 to 100 with up to 4 decimals (RF-M13-01). */
export const InterestRate = z
  .string()
  .regex(INTEREST_RATE_FORMAT)
  .refine((v) => {
    if (!INTEREST_RATE_FORMAT.test(v)) return false;
    const d = new Decimal(v);
    return d.gte(MIN_INTEREST_RATE) && d.lte(MAX_INTEREST_RATE);
  });

const DebtPerson = z.string().trim().min(1).max(40);

const EarmarkWithdrawals = z.array(
  z.object({ goalId: Uuid, accountId: Uuid, amount: Amount }),
);

export const CreateDebtInput = z.object({
  id: Uuid,
  direction: DebtDirection,
  person: DebtPerson,
  principal: Amount,
  currencyCode: CurrencyCode,
  startDate: LocalDate,
  dueDate: LocalDate.optional(),
  note: Note.optional(),
  interest: z.object({ rate: InterestRate, period: InterestPeriod }).optional(),
  initialMovement: z
    .object({ transactionId: Uuid, accountId: Uuid, declaredRate: Rate.optional() })
    .optional(),
});
export type CreateDebtInput = z.infer<typeof CreateDebtInput>;

/** Direction, currency, rate and period are fixed once created (RF-M13-03, RF-M13-10). */
export const UpdateDebtInput = z
  .object({
    person: DebtPerson,
    note: Note,
    dueDate: LocalDate.nullable(),
    principal: Amount,
  })
  .partial()
  .strict();
export type UpdateDebtInput = z.infer<typeof UpdateDebtInput>;

export const PaymentInput = z.object({
  id: Uuid,
  amount: Amount,
  interestPart: Money,
  capitalPart: Money,
  date: LocalDate,
  account: z
    .object({
      accountId: Uuid,
      declaredRate: Rate.optional(),
      capitalTransactionId: Uuid,
      interestTransactionId: Uuid,
    })
    .optional(),
  note: Note.optional(),
  earmarkWithdrawals: EarmarkWithdrawals.optional(),
});
export type PaymentInput = z.infer<typeof PaymentInput>;

export const DeleteDebtInput = z.object({
  movements: z.enum(['delete', 'keep']).optional(),
});
export type DeleteDebtInput = z.infer<typeof DeleteDebtInput>;

export const PaymentDto = z.object({
  id: Uuid,
  amount: Money,
  interestPart: Money,
  capitalPart: Money,
  date: LocalDate,
  note: z.string().optional(),
});
export type PaymentDto = z.infer<typeof PaymentDto>;

export const DebtDto = z.object({
  id: Uuid,
  direction: DebtDirection,
  person: z.string(),
  principal: Money,
  currencyCode: CurrencyCode,
  startDate: LocalDate,
  dueDate: LocalDate.optional(),
  status: DebtStatus,
  capitalOutstanding: Money,
  interestAccrued: Money,
  pending: Money,
  interest: z.object({ rate: z.string(), period: InterestPeriod }).optional(),
  payments: z.array(PaymentDto),
  canDeleteLastPayment: z.boolean(),
  forgivenAmount: Money.optional(),
});
export type DebtDto = z.infer<typeof DebtDto>;

/** Totals per direction and, optionally, the net balance per person (RF-M13-13). */
export const DebtsSummaryDto = z.object({
  iOwe: Money,
  owedToMe: Money,
  byPerson: z
    .array(z.object({ personKey: z.string(), person: z.string(), net: Money }))
    .optional(),
});
export type DebtsSummaryDto = z.infer<typeof DebtsSummaryDto>;
