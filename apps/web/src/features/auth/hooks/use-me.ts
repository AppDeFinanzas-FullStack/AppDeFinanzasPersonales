import type { MeDto } from '@finanzas/contracts';
import { queryOptions, useQuery, type UseQueryResult } from '@tanstack/react-query';

import { ApiError, call } from '@/lib/api-client';
import { clearLastSessionHint, saveLastSessionHint } from '@/lib/last-session-hint';

import { meEndpoint } from '../api';

export const ME_QUERY_KEY = ['me'] as const;

/**
 * Asks for the profile and keeps the hint of this device in step: a confirmed session leaves its
 * hint, a `401` (no session) erases it, and any other failure leaves it as it was.
 */
async function fetchMe(signal: AbortSignal): Promise<MeDto> {
  try {
    const me = await call(meEndpoint, undefined, { signal });
    saveLastSessionHint(me);
    return me;
  } catch (error) {
    if (error instanceof ApiError && error.status === 401) clearLastSessionHint();
    throw error;
  }
}

export const meQuery = queryOptions({
  queryKey: ME_QUERY_KEY,
  queryFn: ({ signal }) => fetchMe(signal),
});

/** The profile of the signed-in user (plan §4.1.4). */
export function useMe(): UseQueryResult<MeDto> {
  return useQuery(meQuery);
}
