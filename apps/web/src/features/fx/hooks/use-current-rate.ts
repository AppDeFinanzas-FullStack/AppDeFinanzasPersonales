import { useQuery } from '@tanstack/react-query';

import { call } from '@/lib/api-client';

import { getCurrentRatesEndpoint } from '../api';

export const CURRENT_RATE_KEY = ['rates', 'current'] as const;

const REFRESH_MS = 60_000;

// Plan §4.3.4: refreshed every 60 s in the background, so it never trips the session dialog (RF-M1-07).
export function useCurrentRate() {
  return useQuery({
    queryKey: CURRENT_RATE_KEY,
    queryFn: ({ signal }) => call(getCurrentRatesEndpoint, undefined, { background: true, signal }),
    refetchInterval: REFRESH_MS,
  });
}
