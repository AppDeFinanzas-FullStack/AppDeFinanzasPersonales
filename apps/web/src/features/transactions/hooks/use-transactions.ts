import { useInfiniteQuery, useQuery } from '@tanstack/react-query';

import { call } from '@/lib/api-client';

import {
  listTransactionsEndpoint,
  transactionsSummaryEndpoint,
  type TransactionFilters,
} from '../api';

/** Every mutation of a movement invalidates this key (plan §4.6.4). */
export const TRANSACTIONS_KEY = ['transactions'] as const;

const PAGE_SIZE = 50;

/** Pages of the list by cursor, loaded while the user scrolls (RF-M6-02, plan §4.6.4). */
export function useTransactions(filters: TransactionFilters) {
  return useInfiniteQuery({
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

/** Income, expense and net of the active filter in the base currency (RF-M6-12). */
export function useTransactionsSummary(filters: TransactionFilters) {
  return useQuery({
    queryKey: [...TRANSACTIONS_KEY, 'summary', filters],
    queryFn: ({ signal }) => call(transactionsSummaryEndpoint, filters, { signal }),
  });
}
