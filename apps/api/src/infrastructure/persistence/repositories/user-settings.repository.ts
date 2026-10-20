import { Decimal } from 'decimal.js';

import type {
  DashboardBlock,
  MarketRateKind,
  UserSettingsData,
  UserSettingsRepository,
} from '../../../application/ports/repositories.js';
import type { TransactionClient } from '../unit-of-work.js';

type SettingsRow = Omit<UserSettingsData, 'favorites'>;

interface FxSettingsRow {
  baseCurrency: string;
  usdReference: MarketRateKind;
  manualUsdValue: string | null;
  manualUsdSince: Date | null;
}

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

    async fxSettings(userId) {
      const rows = await tx.$queryRaw<FxSettingsRow[]>`
        SELECT base_currency::text AS "baseCurrency", usd_reference::text AS "usdReference",
               manual_usd_value::text AS "manualUsdValue", manual_usd_since AS "manualUsdSince"
          FROM user_settings
         WHERE user_id = ${userId}::uuid`;
      const row = rows[0];
      if (row === undefined) {
        return null;
      }
      return {
        baseCurrency: row.baseCurrency.trim(),
        usdReference: row.usdReference,
        manualUsdValue: row.manualUsdValue === null ? null : new Decimal(row.manualUsdValue),
        manualUsdSince: row.manualUsdSince,
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

    async updateFx(userId, changes) {
      const manual = changes.manualUsd;
      const setManual = manual !== undefined;
      await tx.$executeRaw`
        UPDATE user_settings
           SET base_currency = COALESCE(${changes.baseCurrency ?? null}::char(3), base_currency),
               usd_reference = COALESCE(${changes.usdReference ?? null}::market_rate_kind, usd_reference),
               manual_usd_value = CASE WHEN ${setManual}::boolean
                                       THEN ${manual?.value.toFixed(2) ?? null}::numeric
                                       ELSE manual_usd_value END,
               manual_usd_since = CASE WHEN ${setManual}::boolean
                                       THEN ${manual?.since ?? null}::timestamptz
                                       ELSE manual_usd_since END
         WHERE user_id = ${userId}::uuid`;
    },
  };
}
