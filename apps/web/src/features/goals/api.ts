import { GoalDto } from '@finanzas/contracts';
import { z } from 'zod';

import type { Endpoint } from '@/lib/api-client';

const GoalList = z.object({ items: z.array(GoalDto) });
export type GoalList = z.infer<typeof GoalList>;

const GoalHistoryEntry = z.object({
  accountId: z.string(),
  amount: z.string(),
  origin: z.string(),
  date: z.string(),
  createdAt: z.string(),
});
export type GoalHistoryEntry = z.infer<typeof GoalHistoryEntry>;

const GoalDetail = GoalDto.extend({ history: z.array(GoalHistoryEntry) });
export type GoalDetail = z.infer<typeof GoalDetail>;

export const listGoalsEndpoint: Endpoint<undefined, GoalList> = {
  method: 'GET',
  path: '/api/goals',
  input: z.undefined(),
  output: GoalList,
};

export const goalEndpoint = (id: string): Endpoint<undefined, GoalDetail> => ({
  method: 'GET',
  path: `/api/goals/${encodeURIComponent(id)}`,
  input: z.undefined(),
  output: GoalDetail,
});

export const celebratedEndpoint = (id: string): Endpoint<undefined, void> => ({
  method: 'POST',
  path: `/api/goals/${encodeURIComponent(id)}/celebrated`,
  input: z.undefined(),
  output: z.void(),
});
