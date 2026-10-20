import { Decimal } from 'decimal.js';
import { z } from 'zod';

import { IconKey, PaletteKey } from './catalogs.js';
import { CurrencyCode, LocalDate, Money, Note } from './common.js';

const MAX_ABS_BALANCE = '999999999.99';

export const AccountType = z.enum(['cash', 'bank', 'ewallet', 'credit_card', 'savings', 'other']);
export type AccountType = z.infer<typeof AccountType>;

const AccountName = z.string().trim().min(1).max(40);

// Zod 4 keeps running refinements after a failed regex, and Decimal throws on garbage,
// so the bound is only checked when the format is valid.
const AmountAbs = Money.refine((v) => {
  try {
    return new Decimal(v).abs().lte(MAX_ABS_BALANCE);
  } catch {
    return false;
  }
});

const CardBalance = z.object({ kind: z.enum(['debt', 'credit']), amount: AmountAbs });

const CardFields = z.object({
  cutDay: z.number().int().min(1).max(31).nullable(),
  payDay: z.number().int().min(1).max(31).nullable(),
  limit: Money.nullable(),
});

export const CreateAccountInput = z.object({
  id: z.string().uuid(),
  type: AccountType,
  name: AccountName,
  currencyCode: CurrencyCode,
  initialBalance: z.union([AmountAbs, CardBalance]),
  initialBalanceDate: LocalDate,
  color: PaletteKey,
  icon: IconKey,
  card: CardFields.optional(),
});
export type CreateAccountInput = z.infer<typeof CreateAccountInput>;

export const UpdateAccountInput = z
  .object({
    name: AccountName,
    type: AccountType,
    color: PaletteKey,
    icon: IconKey,
    card: CardFields,
    currencyCode: CurrencyCode,
  })
  .partial()
  .strict();
export type UpdateAccountInput = z.infer<typeof UpdateAccountInput>;

export const AdjustInput = z.object({
  transactionId: z.string().uuid(),
  realBalance: z.union([Money, CardBalance]),
  note: Note.optional(),
});
export type AdjustInput = z.infer<typeof AdjustInput>;

export const ArchiveInput = z.object({ confirmNonZero: z.boolean().default(false) });
export type ArchiveInput = z.infer<typeof ArchiveInput>;

export const RestoreInput = z.object({ newName: AccountName.optional() });
export type RestoreInput = z.infer<typeof RestoreInput>;

export const ReorderInput = z.object({ ids: z.array(z.string().uuid()).min(1) });
export type ReorderInput = z.infer<typeof ReorderInput>;

export const AccountDto = z.object({
  id: z.string(),
  type: AccountType,
  name: z.string(),
  currencyCode: CurrencyCode,
  color: PaletteKey,
  icon: IconKey,
  status: z.enum(['active', 'archived']),
  sortOrder: z.number().int(),
  initialBalance: Money,
  initialBalanceDate: LocalDate,
  card: z
    .object({
      cutDay: z.number().int().nullable(),
      payDay: z.number().int().nullable(),
      limit: Money.nullable(),
      creditAvailable: Money.nullable(),
      overLimit: z.boolean(),
    })
    .optional(),
  balance: Money,
  balanceInBase: Money.nullable(),
  balanceInOther: Money.nullable(),
  earmarked: Money,
  free: Money,
  dedicatedGoal: z.object({ id: z.string(), name: z.string() }).optional(),
});
export type AccountDto = z.infer<typeof AccountDto>;

export const AccountsSummaryDto = z.object({
  netWorth: z.object({ base: Money.nullable(), other: Money.nullable() }),
  breakdown: z.object({
    liquid: Money,
    savings: Money,
    cardDebt: Money,
    earmarked: Money,
  }),
});
export type AccountsSummaryDto = z.infer<typeof AccountsSummaryDto>;
