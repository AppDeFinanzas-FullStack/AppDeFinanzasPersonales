import { CreateTransactionInput, RegisterContextDto } from '@finanzas/contracts';
import { z } from 'zod';

import { TransactionItem } from '@/features/transactions/api';
import { TransactionDetailData } from '@/features/transactions/components/transaction-detail';
import type { Endpoint } from '@/lib/api-client';

/**
 * Everything Registrar opens with (`RegisterContextDto`, plan §4.7.2). Without a rate to convert
 * it, the `amountInBase` of a recent movement comes as `null` (EC-M3-02).
 */
export const RegisterContext = RegisterContextDto.extend({
  todayRecent: z.array(TransactionItem),
});
export type RegisterContext = z.infer<typeof RegisterContext>;

export type RegisterAccount = RegisterContext['accounts'][number];

export const registerContextEndpoint: Endpoint<undefined, RegisterContext> = {
  method: 'GET',
  path: '/api/register/context',
  input: z.undefined(),
  output: RegisterContext,
};

/** The answer of saving: the movement, its undo and today's last movements (plan §4.7.2). */
const CreatedTransaction = z.object({
  transaction: TransactionDetailData,
  undoToken: z.string().nullable(),
  todayRecent: z.array(TransactionItem),
});
export type CreatedTransaction = z.infer<typeof CreatedTransaction>;

export const createTransactionEndpoint: Endpoint<CreateTransactionInput, CreatedTransaction> = {
  method: 'POST',
  path: '/api/transactions',
  input: CreateTransactionInput,
  output: CreatedTransaction,
};
