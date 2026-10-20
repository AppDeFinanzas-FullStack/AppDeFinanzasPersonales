import { z } from 'zod';

import { Uuid } from './common.js';

export const NumberFormat = z.enum(['dot_comma', 'comma_dot']);
export type NumberFormat = z.infer<typeof NumberFormat>;

export const DateFormat = z.enum(['dmy', 'iso', 'short_text']);
export type DateFormat = z.infer<typeof DateFormat>;

export const WeekStart = z.enum(['monday', 'sunday']);
export type WeekStart = z.infer<typeof WeekStart>;

export const Theme = z.enum(['system', 'light', 'dark']);
export type Theme = z.infer<typeof Theme>;

export const DashboardBlockKey = z.enum([
  'budget',
  'byCategory',
  'pace',
  'upcoming',
  'balances',
  'recent',
]);
export type DashboardBlockKey = z.infer<typeof DashboardBlockKey>;

export const DashboardBlock = z.object({ key: DashboardBlockKey, visible: z.boolean() });
export type DashboardBlock = z.infer<typeof DashboardBlock>;

export const FavoriteKind = z.enum(['expense', 'income']);
export type FavoriteKind = z.infer<typeof FavoriteKind>;

export const MAX_FAVORITE_CATEGORIES = 8;

export const DEFAULT_DASHBOARD_BLOCKS: readonly DashboardBlock[] = DashboardBlockKey.options.map(
  (key) => ({ key, visible: true }),
);

export const UpdateSettingsInput = z
  .object({
    numberFormat: NumberFormat,
    dateFormat: DateFormat,
    weekStart: WeekStart,
    theme: Theme,
    sidebarCollapsed: z.boolean(),
    defaultAccountId: Uuid.nullable(),
    alwaysShowNote: z.boolean(),
    dashboardBlocks: z.array(DashboardBlock).length(DashboardBlockKey.options.length),
    favoriteCategories: z.object({
      kind: FavoriteKind,
      ids: z.array(Uuid).max(MAX_FAVORITE_CATEGORIES),
    }),
  })
  .partial()
  .strict();
export type UpdateSettingsInput = z.infer<typeof UpdateSettingsInput>;

export const ResetSettingsInput = z.object({
  section: z.enum(['general', 'currencies', 'register', 'dashboard', 'reminders']),
});
export type ResetSettingsInput = z.infer<typeof ResetSettingsInput>;

export interface SettingsDto {
  numberFormat: NumberFormat;
  dateFormat: DateFormat;
  weekStart: WeekStart;
  theme: Theme;
  sidebarCollapsed: boolean;
  defaultAccountId: string | null;
  alwaysShowNote: boolean;
  dashboardBlocks: DashboardBlock[];
  favorites: { expense: string[]; income: string[] };
}
