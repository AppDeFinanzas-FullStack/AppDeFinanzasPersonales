import type { ConfirmOccurrenceInput } from '@finanzas/contracts';
import { queryOptions, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { call } from '@/lib/api-client';

import { confirmOccurrenceEndpoint, overviewEndpoint, skipOccurrenceEndpoint } from '../api';

export const RECURRING_KEY = ['recurring'] as const;

// Plan §4.14.4: `['recurring']`.
export function recurringQuery() {
  return queryOptions({
    queryKey: RECURRING_KEY,
    queryFn: ({ signal }) => call(overviewEndpoint, undefined, { signal }),
  });
}

export function useRecurring() {
  return useQuery(recurringQuery());
}

/** Confirming registers a movement, so it also refreshes the movements, accounts and Inicio. */
export function useConfirmOccurrence(occurrenceId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: ConfirmOccurrenceInput) =>
      call(confirmOccurrenceEndpoint(occurrenceId), input),
    onSuccess: async () => {
      await Promise.all(
        [RECURRING_KEY, ['transactions'], ['accounts'], ['dashboard']].map((queryKey) =>
          queryClient.invalidateQueries({ queryKey }),
        ),
      );
    },
  });
}

export function useSkipOccurrence() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (occurrenceId: string) => call(skipOccurrenceEndpoint(occurrenceId), undefined),
    onSettled: () => queryClient.invalidateQueries({ queryKey: RECURRING_KEY }),
  });
}
