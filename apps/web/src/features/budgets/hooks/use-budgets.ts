import type { CreateBudgetInput, DecisionInput, UpdateBudgetInput } from '@finanzas/contracts';
import {
  available,
  BOLIVIA_TIME_ZONE,
  pace,
  todayFor,
  todayShouldBe,
  type LocalDate,
} from '@finanzas/domain';
import { queryOptions, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { ACCOUNTS_KEY } from '@/features/accounts/hooks/use-accounts';
import { useMe } from '@/features/auth/hooks/use-me';
import { GOALS_KEY } from '@/features/goals/hooks/use-goals';
import { NOTIFICATIONS_KEY } from '@/features/notifications/hooks/use-notifications';
import { call } from '@/lib/api-client';

import {
  budgetActionEndpoint,
  budgetEndpoint,
  closeDecisionEndpoint,
  createBudgetEndpoint,
  deleteBudgetEndpoint,
  listBudgetsEndpoint,
  updateBudgetEndpoint,
  type BudgetDetail,
} from '../api';

export const BUDGETS_KEY = ['budgets'] as const;

export const budgetKey = (id: string) => ['budget', id] as const;

// Plan §4.11.4: `['budgets']`.
export function budgetsQuery() {
  return queryOptions({
    queryKey: BUDGETS_KEY,
    queryFn: ({ signal }) => call(listBudgetsEndpoint, undefined, { signal }),
  });
}

export function useBudgets() {
  return useQuery(budgetsQuery());
}

// Plan §4.11.4: `['budget', id]`.
export function useBudget(id: string) {
  return useQuery({
    queryKey: budgetKey(id),
    queryFn: ({ signal }) => call(budgetEndpoint(id), undefined, { signal }),
    retry: false,
  });
}

/** Reads a budget through the cache, to edit the existing one (EC-M11-06). */
export function useFetchBudget(): (id: string) => Promise<BudgetDetail> {
  const queryClient = useQueryClient();
  return (id) =>
    queryClient.fetchQuery({
      queryKey: budgetKey(id),
      queryFn: ({ signal }) => call(budgetEndpoint(id), undefined, { signal }),
    });
}

/** Creates a budget with the `id` of the client (ADR-11). */
export function useCreateBudget() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateBudgetInput) => call(createBudgetEndpoint, input),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: BUDGETS_KEY });
    },
  });
}

/** Edits a budget; the currency never travels (RF-M11-07). */
export function useUpdateBudget(id: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: UpdateBudgetInput) => call(updateBudgetEndpoint(id), input),
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: budgetKey(id) }),
        queryClient.invalidateQueries({ queryKey: BUDGETS_KEY }),
      ]);
    },
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

/**
 * Applies the decision of a closed period (RF-M11-08). The budget, the goals and the accounts it may
 * touch, and the inbox that shows the same decision, are read again afterwards.
 */
export function useCloseDecision(id: string, periodId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: DecisionInput) => call(closeDecisionEndpoint(id, periodId), input),
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: budgetKey(id) }),
        queryClient.invalidateQueries({ queryKey: BUDGETS_KEY }),
        queryClient.invalidateQueries({ queryKey: GOALS_KEY }),
        queryClient.invalidateQueries({ queryKey: ACCOUNTS_KEY }),
        queryClient.invalidateQueries({ queryKey: NOTIFICATIONS_KEY }),
      ]);
    },
  });
}
