import { infiniteQueryOptions, useInfiniteQuery, useQuery } from '@tanstack/react-query';

import { call } from '@/lib/api-client';

import {
  listTransactionsEndpoint,
  transactionsSummaryEndpoint,
  type TransactionFilters,
} from '../api';

/** Every mutation of a movement invalidates this key (plan §4.6.4). */
export const TRANSACTIONS_KEY = ['transactions'] as const;

const PAGE_SIZE = 50;

/**
 * Pages of the list by cursor (RF-M6-02, plan §4.6.4). The screen reads it and the route prefetches
 * it through this same factory, so both share one cache entry.
 */
export function transactionsQuery(filters: TransactionFilters) {
  return infiniteQueryOptions({
    queryKey: [...TRANSACTIONS_KEY, 'list', filters],
    queryFn: ({ pageParam, signal }) =>
      call(
        listTransactionsEndpoint,
        { ...filters, limit: PAGE_SIZE, ...(pageParam === null ? {} : { cursor: pageParam }) },
        { signal },
      ),
    initialPageParam: null as string | null,
    getNextPageParam: (last) => last.nextCursor,
  });
}

/** Pages of the list by cursor, loaded while the user scrolls (RF-M6-02, plan §4.6.4). */
export function useTransactions(filters: TransactionFilters) {
  return useInfiniteQuery(transactionsQuery(filters));
}

/** Income, expense and net of the active filter in the base currency (RF-M6-12). */
export function useTransactionsSummary(filters: TransactionFilters) {
  return useQuery({
    queryKey: [...TRANSACTIONS_KEY, 'summary', filters],
    queryFn: ({ signal }) => call(transactionsSummaryEndpoint, filters, { signal }),
  });
}
