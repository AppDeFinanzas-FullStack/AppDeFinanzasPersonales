import type { MeDto } from '@finanzas/contracts';
import { useQuery, type UseQueryResult } from '@tanstack/react-query';

import { call } from '@/lib/api-client';

import { meEndpoint } from '../api';

export const ME_QUERY_KEY = ['me'] as const;

/** The profile of the signed-in user (plan §4.1.4). */
export function useMe(): UseQueryResult<MeDto> {
  return useQuery({
    queryKey: ME_QUERY_KEY,
    queryFn: ({ signal }) => call(meEndpoint, undefined, { signal }),
  });
}
