import { DebtDto, DebtsSummaryDto, type DeleteDebtInput } from '@finanzas/contracts';
import { z } from 'zod';

import type { Endpoint } from '@/lib/api-client';

export type DebtsView = 'debt' | 'person';

const DebtList = z.object({ debts: z.array(DebtDto), summary: DebtsSummaryDto });
export type DebtList = z.infer<typeof DebtList>;

const debtPath = (id: string): string => `/api/debts/${encodeURIComponent(id)}`;

export const listDebtsEndpoint: Endpoint<{ view: DebtsView }, DebtList> = {
  method: 'GET',
  path: '/api/debts',
  input: z.object({ view: z.enum(['debt', 'person']) }),
  output: DebtList,
};

export const forgiveDebtEndpoint = (id: string): Endpoint<undefined, DebtDto> => ({
  method: 'POST',
  path: `${debtPath(id)}/forgive`,
  input: z.undefined(),
  output: DebtDto,
});

export const deleteLastPaymentEndpoint = (id: string): Endpoint<undefined, DebtDto> => ({
  method: 'DELETE',
  path: `${debtPath(id)}/payments/last`,
  input: z.undefined(),
  output: DebtDto,
});

/** The choice about the linked movements travels in the query (RF-M13-11). */
export const deleteDebtEndpoint = (id: string): Endpoint<DeleteDebtInput, void> => ({
  method: 'DELETE',
  path: debtPath(id),
  input: z.object({ movements: z.enum(['delete', 'keep']).optional() }),
  output: z.void(),
});
