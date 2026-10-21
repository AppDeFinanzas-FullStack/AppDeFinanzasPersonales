import { DashboardDto, DashboardQuery } from '@finanzas/contracts';

import type { Endpoint } from '@/lib/api-client';

export const getDashboardEndpoint: Endpoint<DashboardQuery, DashboardDto> = {
  method: 'GET',
  path: '/api/dashboard',
  input: DashboardQuery,
  output: DashboardDto,
};
