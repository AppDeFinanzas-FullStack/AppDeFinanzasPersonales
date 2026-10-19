import { QueryClient } from '@tanstack/react-query';

import { ApiError } from '@/lib/api-client';
import { online } from '@/lib/online';

const MAX_QUERY_RETRIES = 2;

// A 4xx is the API's final answer: repeating the same request cannot change it.
function shouldRetryQuery(failureCount: number, error: unknown): boolean {
  if (error instanceof ApiError && error.status < 500) return false;
  return failureCount < MAX_QUERY_RETRIES;
}

export function createQueryClient(): QueryClient {
  const queryClient = new QueryClient({
    defaultOptions: {
      // Plan §4.9.3, EC-M9-01: other devices see the change when the window regains focus.
      queries: { refetchOnWindowFocus: true, retry: shouldRetryQuery },
      // ADR-11, EC-M2-02: a mutation is resent only by `online`, once and with the same id.
      mutations: { retry: false },
    },
  });
  online.attach(queryClient);
  return queryClient;
}

export const queryClient: QueryClient = createQueryClient();
