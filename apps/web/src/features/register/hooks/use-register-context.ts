import type { CreateTransactionInput } from '@finanzas/contracts';
import { queryOptions, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { AFFECTED_KEYS } from '@/features/transactions/hooks/use-delete-transaction';
import { call } from '@/lib/api-client';

import { createTransactionEndpoint, registerContextEndpoint } from '../api';

/** Plan §4.7.4: the context of Registrar, updated with the answer of saving. */
export const REGISTER_CONTEXT_KEY = ['register', 'context'] as const;

/**
 * The context is prefetched as soon as the session is ready and the screen reads it from the
 * cache, so opening Registrar makes no request before the user types (RNF-01, plan §4.7.4).
 */
export const registerContextQuery = queryOptions({
  queryKey: REGISTER_CONTEXT_KEY,
  queryFn: ({ signal }) => call(registerContextEndpoint, undefined, { signal }),
  staleTime: Infinity,
});

export function useRegisterContext() {
  return useQuery(registerContextQuery);
}

/** Saves a movement of Registrar in one request (plan §4.7.2, RNF-02). */
export function useCreateTransaction() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateTransactionInput) => call(createTransactionEndpoint, input),
    // Not awaited, so the form is ready again while the other screens refresh (plan §4.6.4).
    onSuccess: () => {
      for (const queryKey of AFFECTED_KEYS) void queryClient.invalidateQueries({ queryKey });
    },
  });
}
