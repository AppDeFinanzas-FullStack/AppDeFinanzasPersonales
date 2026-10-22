import type { z } from 'zod';

import { TransactionItem } from './api';

/** A movement with its fee and its origin for "Ir a…" (`GET /api/transactions/:id`). */
export const TransactionDetailData = TransactionItem.extend({ fee: TransactionItem.optional() });
export type TransactionDetailData = z.infer<typeof TransactionDetailData>;
