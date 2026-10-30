import { queryOptions, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback } from 'react';

import { call } from '@/lib/api-client';

import {
  listAccountsEndpoint,
  listCurrenciesEndpoint,
  reorderAccountsEndpoint,
  type AccountStatus,
} from '../api';

export const ACCOUNTS_KEY = ['accounts'] as const;

/** Symbols of the two system currencies (RF-M3-01). */
const SYSTEM_SYMBOLS: Record<string, string> = { BOB: 'Bs', USD: '$' };

// Plan §4.4.4: `['accounts', status]`.
export function accountsQuery(status: AccountStatus) {
  return queryOptions({
    queryKey: [...ACCOUNTS_KEY, status],
    queryFn: ({ signal }) => call(listAccountsEndpoint, { status }, { signal }),
  });
}

export function useAccounts(status: AccountStatus) {
  return useQuery(accountsQuery(status));
}

/** Saves the order of every account of the user, archived ones included (RF-M4-11). */
export function useReorderAccounts() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (ids: string[]) => call(reorderAccountsEndpoint, { ids }),
    onSettled: () => queryClient.invalidateQueries({ queryKey: ACCOUNTS_KEY }),
  });
}

/** The symbol of a currency: Bs and $ for the system ones, the user's symbol otherwise. */
export function useCurrencySymbol(): (code: string) => string {
  const { data } = useQuery({
    queryKey: ['currencies'],
    queryFn: ({ signal }) => call(listCurrenciesEndpoint, undefined, { signal }),
  });
  return useCallback(
    (code: string) =>
      SYSTEM_SYMBOLS[code] ??
      data?.items.find((currency) => currency.code === code)?.symbol ??
      code,
    [data],
  );
}
