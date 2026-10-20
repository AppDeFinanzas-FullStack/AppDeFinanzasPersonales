import {
  DashboardBlock,
  DateFormat,
  NumberFormat,
  Theme,
  UpdateSettingsInput,
  WeekStart,
  type SettingsDto,
} from '@finanzas/contracts';
import { z } from 'zod';

import type { Endpoint } from '@/lib/api-client';

const SettingsOutput: z.ZodType<SettingsDto> = z.object({
  numberFormat: NumberFormat,
  dateFormat: DateFormat,
  weekStart: WeekStart,
  theme: Theme,
  sidebarCollapsed: z.boolean(),
  defaultAccountId: z.string().nullable(),
  alwaysShowNote: z.boolean(),
  dashboardBlocks: z.array(DashboardBlock),
  favorites: z.object({ expense: z.array(z.string()), income: z.array(z.string()) }),
});

export const getSettingsEndpoint: Endpoint<undefined, SettingsDto> = {
  method: 'GET',
  path: '/api/settings',
  input: z.undefined(),
  output: SettingsOutput,
};

export const updateSettingsEndpoint: Endpoint<UpdateSettingsInput, SettingsDto> = {
  method: 'PATCH',
  path: '/api/settings',
  input: UpdateSettingsInput,
  output: SettingsOutput,
};
