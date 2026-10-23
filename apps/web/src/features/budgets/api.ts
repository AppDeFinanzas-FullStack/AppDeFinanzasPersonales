import { BudgetDto } from '@finanzas/contracts';
import { z } from 'zod';

import type { Endpoint } from '@/lib/api-client';

const BudgetList = z.object({ items: z.array(BudgetDto) });
export type BudgetList = z.infer<typeof BudgetList>;

const BudgetPeriodSummary = z.object({
  id: z.string(),
  start: z.string(),
  end: z.string(),
  amount: z.string(),
  carryoverIn: z.string(),
  status: z.enum(['open', 'closed_pending', 'decided', 'defaulted']),
});
export type BudgetPeriodSummary = z.infer<typeof BudgetPeriodSummary>;

/** A budget with its 12 last periods (plan §4.11.2). */
const BudgetDetail = BudgetDto.extend({ periods: z.array(BudgetPeriodSummary) });
export type BudgetDetail = z.infer<typeof BudgetDetail>;

const path = (id: string, action = '') => `/api/budgets/${encodeURIComponent(id)}${action}`;

export const listBudgetsEndpoint: Endpoint<undefined, BudgetList> = {
  method: 'GET',
  path: '/api/budgets',
  input: z.undefined(),
  output: BudgetList,
};

export const budgetEndpoint = (id: string): Endpoint<undefined, BudgetDetail> => ({
  method: 'GET',
  path: path(id),
  input: z.undefined(),
  output: BudgetDetail,
});

export const budgetActionEndpoint = (
  id: string,
  action: 'pause' | 'resume' | 'reset-carryover',
): Endpoint<undefined, void> => ({
  method: 'POST',
  path: path(id, `/${action}`),
  input: z.undefined(),
  output: z.void(),
});

export const deleteBudgetEndpoint = (id: string): Endpoint<undefined, void> => ({
  method: 'DELETE',
  path: path(id),
  input: z.undefined(),
  output: z.void(),
});
