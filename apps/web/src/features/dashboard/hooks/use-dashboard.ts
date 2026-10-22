import { todayFor } from '@finanzas/domain';
import { queryOptions, useQuery } from '@tanstack/react-query';

import { call } from '@/lib/api-client';

import { getDashboardEndpoint } from '../api';

export const DASHBOARD_KEY = ['dashboard'] as const;

// Plan §4.8.4: `['dashboard', month]`, always stale and invalidated by every mutation (RF-M8-11).
export function dashboardQuery(month: string) {
  return queryOptions({
    queryKey: [...DASHBOARD_KEY, month],
    queryFn: ({ signal }) => call(getDashboardEndpoint, { month }, { signal }),
    staleTime: 0,
  });
}

export function useDashboard(month: string) {
  return useQuery(dashboardQuery(month));
}

/** The month (`YYYY-MM`) the Inicio shows first: the current one in the user's time zone. */
export function currentMonthFor(timeZone: string): string {
  return todayFor(timeZone, new Date()).slice(0, 7);
}
