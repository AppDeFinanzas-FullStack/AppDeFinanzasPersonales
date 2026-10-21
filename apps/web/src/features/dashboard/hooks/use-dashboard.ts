import { useQuery } from '@tanstack/react-query';

import { call } from '@/lib/api-client';

import { getDashboardEndpoint } from '../api';

export const DASHBOARD_KEY = ['dashboard'] as const;

// Plan §4.8.4: `['dashboard', month]`, always stale and invalidated by every mutation (RF-M8-11).
export function useDashboard(month: string) {
  return useQuery({
    queryKey: [...DASHBOARD_KEY, month],
    queryFn: ({ signal }) => call(getDashboardEndpoint, { month }, { signal }),
    staleTime: 0,
  });
}
