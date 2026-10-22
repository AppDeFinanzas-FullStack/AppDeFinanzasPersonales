import type { GoalDto } from '@finanzas/contracts';
import { toMoneyString } from '@finanzas/domain';

import type { GoalDetail } from '../../application/services/goals.service.js';

/** Builds the answers of `/api/goals` (plan §4.12.2). Money travels as text (ADR-03). */
export const GoalsPresenter = {
  one(goal: GoalDto): GoalDto {
    return goal;
  },

  list(goals: GoalDto[]): { items: GoalDto[] } {
    return { items: goals };
  },

  detail(goal: GoalDetail) {
    const { history, ...dto } = goal;
    return {
      ...dto,
      history: history.map((item) => ({
        accountId: item.accountId,
        amount: toMoneyString(item.amount),
        origin: item.origin,
        date: item.date,
        createdAt: item.createdAt.toISOString(),
      })),
    };
  },
};
