import type {
  DashboardBlock,
  UserSettingsData,
  UserSettingsRepository,
} from '../../../application/ports/repositories.js';
import type { TransactionClient } from '../unit-of-work.js';

type SettingsRow = Omit<UserSettingsData, 'favorites'>;

/** Prisma implementation of the general settings, bound to the transaction `tx`. */
export function createUserSettingsRepository(tx: TransactionClient): UserSettingsRepository {
  return {
    async find(userId) {
      const rows = await tx.$queryRaw<SettingsRow[]>`
        SELECT number_format::text AS "numberFormat", date_format::text AS "dateFormat",
               week_start::text AS "weekStart", theme::text AS theme,
               sidebar_collapsed AS "sidebarCollapsed",
               default_account_id::text AS "defaultAccountId",
               always_show_note AS "alwaysShowNote", dashboard_blocks AS "dashboardBlocks"
          FROM user_settings
         WHERE user_id = ${userId}::uuid`;
      const row = rows[0];
      if (row === undefined) {
        return null;
      }
      const favorites = await tx.$queryRaw<{ id: string; kind: 'expense' | 'income' }[]>`
        SELECT category_id::text AS id, kind::text AS kind
          FROM favorite_category
         WHERE user_id = ${userId}::uuid
         ORDER BY position`;
      return {
        ...row,
        favorites: {
          expense: favorites.filter((f) => f.kind === 'expense').map((f) => f.id),
          income: favorites.filter((f) => f.kind === 'income').map((f) => f.id),
        },
      };
    },

    async update(userId, changes) {
      const blocks: DashboardBlock[] | undefined = changes.dashboardBlocks;
      await tx.$executeRaw`
        UPDATE user_settings
           SET number_format = COALESCE(${changes.numberFormat ?? null}::number_format, number_format),
               date_format = COALESCE(${changes.dateFormat ?? null}::date_format, date_format),
               week_start = COALESCE(${changes.weekStart ?? null}::week_start, week_start),
               theme = COALESCE(${changes.theme ?? null}::theme_mode, theme),
               sidebar_collapsed = COALESCE(${changes.sidebarCollapsed ?? null}::boolean, sidebar_collapsed),
               always_show_note = COALESCE(${changes.alwaysShowNote ?? null}::boolean, always_show_note),
               dashboard_blocks = COALESCE(${blocks === undefined ? null : JSON.stringify(blocks)}::jsonb, dashboard_blocks)
         WHERE user_id = ${userId}::uuid`;
    },
  };
}
