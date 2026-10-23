import {
  available,
  BOLIVIA_TIME_ZONE,
  pace,
  todayFor,
  todayShouldBe,
  type LocalDate,
} from '@finanzas/domain';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { useMe } from '@/features/auth/hooks/use-me';
import { call } from '@/lib/api-client';

import {
  budgetActionEndpoint,
  budgetEndpoint,
  deleteBudgetEndpoint,
  listBudgetsEndpoint,
  type BudgetDetail,
} from '../api';

export const BUDGETS_KEY = ['budgets'] as const;

export const budgetKey = (id: string) => ['budget', id] as const;

// Plan §4.11.4: `['budgets']`.
export function useBudgets() {
  return useQuery({
    queryKey: BUDGETS_KEY,
    queryFn: ({ signal }) => call(listBudgetsEndpoint, undefined, { signal }),
  });
}

// Plan §4.11.4: `['budget', id]`.
export function useBudget(id: string) {
  return useQuery({
    queryKey: budgetKey(id),
    queryFn: ({ signal }) => call(budgetEndpoint(id), undefined, { signal }),
    retry: false,
  });
}

/** Pausar and Reanudar: both caches are refreshed afterwards. */
export function useBudgetAction(id: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (action: 'pause' | 'resume') => call(budgetActionEndpoint(id, action), undefined),
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: budgetKey(id) }),
        queryClient.invalidateQueries({ queryKey: BUDGETS_KEY }),
      ]);
    },
  });
}

/**
 * The period in course once its carryover is 0 and its late adjustments are voided (RF-M11-12):
 * the available, the even pace and "hoy deberías llevar" follow the same domain rules as the API.
 */
function withCarryoverReset(budget: BudgetDetail, today: LocalDate): BudgetDetail {
  const { current } = budget;
  if (current === undefined) return budget;
  const period = { start: current.start, end: current.end };
  const total = available(budget.amount, '0.00', []);
  return {
    ...budget,
    current: {
      ...current,
      carryover: '0.00',
      lateAdjustments: [],
      available: total,
      todayShouldBe: todayShouldBe(total, period, today),
      pace: pace(total, current.spent, period, today),
    },
  };
}

/**
 * Reiniciar arrastre: the detail is updated in place with the known result and both caches are
 * marked stale, to be read again the next time they are shown.
 */
export function useResetCarryover(id: string) {
  const queryClient = useQueryClient();
  const me = useMe();
  return useMutation({
    mutationFn: () => call(budgetActionEndpoint(id, 'reset-carryover'), undefined),
    onSuccess: async () => {
      const today = todayFor(me.data?.timezone ?? BOLIVIA_TIME_ZONE, new Date());
      queryClient.setQueryData<BudgetDetail>(budgetKey(id), (budget) =>
        budget === undefined ? budget : withCarryoverReset(budget, today),
      );
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: budgetKey(id), refetchType: 'none' }),
        queryClient.invalidateQueries({ queryKey: BUDGETS_KEY, refetchType: 'none' }),
      ]);
    },
  });
}

/**
 * Eliminar: leaves the detail through `onDeleted` and only then drops it from the cache, so the
 * screen being left does not ask again for a budget that no longer exists.
 */
export function useDeleteBudget(id: string, onDeleted: () => Promise<void>) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => call(deleteBudgetEndpoint(id), undefined),
    onSuccess: async () => {
      await onDeleted();
      queryClient.removeQueries({ queryKey: budgetKey(id) });
      await queryClient.invalidateQueries({ queryKey: BUDGETS_KEY });
    },
  });
}
