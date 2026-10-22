import { DashboardViewDto, DashboardQuery } from '@finanzas/contracts';

import type { Endpoint } from '@/lib/api-client';

export const getDashboardEndpoint: Endpoint<DashboardQuery, DashboardViewDto> = {
  method: 'GET',
  path: '/api/dashboard',
  input: DashboardQuery,
  output: DashboardViewDto,
};
