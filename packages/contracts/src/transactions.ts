import { z } from 'zod';

import { Amount, CurrencyCode, LocalDate, Money, Note, Rate, Uuid } from './common.js';

export const EarmarkWithdrawals = z.array(
  z.object({ goalId: Uuid, accountId: Uuid, amount: Amount }),
);

export type EarmarkWithdrawals = z.infer<typeof EarmarkWithdrawals>;

const SimpleTransactionInput = {
  id: Uuid,
  accountId: Uuid,
  categoryId: Uuid,
  amount: Amount,
  date: LocalDate,
  note: Note.optional(),
  earmarkWithdrawals: EarmarkWithdrawals.optional(),
  manualUsdRate: Rate.optional(),
};

export const CreateTransactionInput = z
  .discriminatedUnion('kind', [
    z.object({ kind: z.literal('expense'), ...SimpleTransactionInput }),
    z.object({ kind: z.literal('income'), ...SimpleTransactionInput }),
    z.object({
      kind: z.literal('transfer'),
      id: Uuid,
      fromAccountId: Uuid,
      toAccountId: Uuid,
      amountOut: Amount,
      amountIn: Amount.optional(),
      declaredRate: Rate.optional(),
      date: LocalDate,
      note: Note.optional(),
      fee: z.object({ id: Uuid, amount: Amount, categoryId: Uuid.optional() }).optional(),
      earmarkWithdrawals: EarmarkWithdrawals.optional(),
    }),
  ])
  .refine((t) => t.kind !== 'transfer' || t.fromAccountId !== t.toAccountId, {
    message: 'SAME_ACCOUNT',
  });
export type CreateTransactionInput = z.infer<typeof CreateTransactionInput>;

export const UpdateTransactionInput = z
  .object({
    amount: Amount,
    accountId: Uuid,
    amountInNewCurrency: Amount,
    // Only transfers change their origin and destination (RF-M6-07).
    fromAccountId: Uuid,
    toAccountId: Uuid,
    categoryId: Uuid,
    date: LocalDate,
    note: Note.nullable(),
    rateUsdBob: Rate,
    rateCurBob: Rate,
    declaredRate: Rate,
    earmarkWithdrawals: EarmarkWithdrawals,
  })
  .partial()
  .strict()
  .refine((t) => t.fromAccountId === undefined || t.fromAccountId !== t.toAccountId, {
    message: 'SAME_ACCOUNT',
  });
export type UpdateTransactionInput = z.infer<typeof UpdateTransactionInput>;

export const TransactionKind = z.enum(['expense', 'income', 'transfer', 'adjustment']);
export type TransactionKind = z.infer<typeof TransactionKind>;

export const ListQuery = z.object({
  month: z
    .string()
    .regex(/^\d{4}-\d{2}$/)
    .optional(),
  from: LocalDate.optional(),
  to: LocalDate.optional(),
  accountId: Uuid.optional(),
  categoryId: Uuid.optional(),
  kind: TransactionKind.optional(),
  q: z.string().trim().max(60).optional(),
  cursor: z.string().optional(),
  limit: z.number().int().min(1).max(100).default(50),
});
export type ListQuery = z.infer<typeof ListQuery>;

export const BatchDeleteInput = z.object({ ids: z.array(Uuid).min(1).max(200) });
export type BatchDeleteInput = z.infer<typeof BatchDeleteInput>;

export const BatchRecategorizeInput = BatchDeleteInput.extend({ categoryId: Uuid });
export type BatchRecategorizeInput = z.infer<typeof BatchRecategorizeInput>;

export const UndoInput = z.object({
  undoToken: Uuid,
  earmarkWithdrawals: EarmarkWithdrawals.optional(),
});
export type UndoInput = z.infer<typeof UndoInput>;

export const DeleteTransactionInput = z.object({
  earmarkWithdrawals: EarmarkWithdrawals.optional(),
});
export type DeleteTransactionInput = z.infer<typeof DeleteTransactionInput>;

export interface TransactionDto {
  id: string;
  kind: TransactionKind;
  date: string;
  note: string | null;
  category?: { id: string; name: string } | null;
  entries: { accountId: string; amount: string; currencyCode: string }[];
  origin: string;
  originId?: string | null;
  linkedLocked: boolean;
  recurringLabel?: string | null;
  beforeInitialBalance: boolean;
  rateUsdBob?: string | null;
  rateCurBob: string;
  declaredRate?: string | null;
  amountInBase: string;
  createdAt: string;
  fee?: TransactionDto;
}

export const TransactionDto: z.ZodType<TransactionDto> = z.lazy(() =>
  z.object({
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
    amountInBase: Money,
    createdAt: z.string(),
    fee: TransactionDto.optional(),
  }),
);
