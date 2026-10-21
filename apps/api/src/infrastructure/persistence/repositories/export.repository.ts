import { Prisma } from '@finanzas/db';

import type { ExportRepository, ExportTable } from '../../../application/ports/repositories.js';
import type { TransactionClient } from '../unit-of-work.js';

/** An instant column in ISO 8601 UTC; `column` is always a constant of this file. */
const instant = (column: string): Prisma.Sql =>
  Prisma.raw(`to_char(${column} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`);

/**
 * Prisma implementation over the V1.0 tables, always filtered by the user of the transaction
 * (RN-09). Every column is read as text, so decimals keep their exact value (ADR-03).
 */
export function createExportRepository(tx: TransactionClient, userId: string): ExportRepository {
  /** Runs the query, whose aliases are the column names, and keeps the rows in that order. */
  const table = async (columns: string[], query: Prisma.Sql): Promise<ExportTable> => {
    const records = await tx.$queryRaw<Record<string, string | null>[]>(query);
    return { columns, rows: records.map((record) => columns.map((c) => record[c] ?? '')) };
  };

  return {
    profile() {
      return table(
        ['name', 'email', 'timezone', 'locale', 'registered_at', 'terms_accepted_at'],
        Prisma.sql`
          SELECT u.name, u.email, u.timezone, u.locale,
                 ${instant('u.registered_at')} AS registered_at,
                 ${instant('u.terms_accepted_at')} AS terms_accepted_at
            FROM auth_user u
           WHERE u.id = ${userId}::uuid`,
      );
    },

    settings() {
      return table(
        [
          'number_format',
          'date_format',
          'week_start',
          'theme',
          'sidebar_collapsed',
          'base_currency',
          'usd_reference',
          'manual_usd_value',
          'manual_usd_since',
          'default_account_id',
          'always_show_note',
          'dashboard_blocks',
          'onboarding_step',
          'onboarding_completed_at',
        ],
        Prisma.sql`
          SELECT s.number_format::text AS number_format, s.date_format::text AS date_format,
                 s.week_start::text AS week_start, s.theme::text AS theme,
                 s.sidebar_collapsed::text AS sidebar_collapsed, s.base_currency,
                 s.usd_reference::text AS usd_reference,
                 s.manual_usd_value::text AS manual_usd_value,
                 ${instant('s.manual_usd_since')} AS manual_usd_since,
                 s.default_account_id::text AS default_account_id,
                 s.always_show_note::text AS always_show_note,
                 s.dashboard_blocks::text AS dashboard_blocks,
                 s.onboarding_step::text AS onboarding_step,
                 ${instant('s.onboarding_completed_at')} AS onboarding_completed_at
            FROM user_settings s
           WHERE s.user_id = ${userId}::uuid`,
      );
    },

    favoriteCategories() {
      return table(
        ['category_id', 'kind', 'position'],
        Prisma.sql`
          SELECT f.category_id::text AS category_id, f.kind::text AS kind,
                 f.position::text AS position
            FROM favorite_category f
           WHERE f.user_id = ${userId}::uuid
           ORDER BY f.kind, f.position`,
      );
    },

    currencies() {
      return table(
        ['code', 'symbol', 'is_system', 'status', 'created_at'],
        Prisma.sql`
          SELECT c.code, c.symbol, c.is_system::text AS is_system, c.status::text AS status,
                 ${instant('c.created_at')} AS created_at
            FROM currency c
           WHERE c.user_id = ${userId}::uuid
           ORDER BY c.created_at, c.code`,
      );
    },

    fxEvents() {
      return table(
        ['id', 'kind', 'currency_code', 'reference', 'value', 'effective_at'],
        Prisma.sql`
          SELECT e.id::text AS id, e.kind::text AS kind, e.currency_code,
                 e.reference::text AS reference, e.value::text AS value,
                 ${instant('e.effective_at')} AS effective_at
            FROM user_fx_event e
           WHERE e.user_id = ${userId}::uuid
           ORDER BY e.effective_at, e.id`,
      );
    },

    accounts() {
      return table(
        [
          'id',
          'type',
          'name',
          'currency_code',
          'initial_balance',
          'initial_balance_date',
          'color',
          'icon',
          'card_cut_day',
          'card_pay_day',
          'card_limit',
          'status',
          'archived_at',
          'sort_order',
          'created_at',
        ],
        Prisma.sql`
          SELECT a.id::text AS id, a.type::text AS type, a.name, a.currency_code,
                 a.initial_balance::text AS initial_balance,
                 a.initial_balance_date::text AS initial_balance_date, a.color, a.icon,
                 a.card_cut_day::text AS card_cut_day, a.card_pay_day::text AS card_pay_day,
                 a.card_limit::text AS card_limit, a.status::text AS status,
                 ${instant('a.archived_at')} AS archived_at, a.sort_order::text AS sort_order,
                 ${instant('a.created_at')} AS created_at
            FROM account a
           WHERE a.user_id = ${userId}::uuid
           ORDER BY a.status, a.sort_order, a.id`,
      );
    },

    categories() {
      return table(
        [
          'id',
          'kind',
          'parent_id',
          'name',
          'color',
          'icon',
          'is_system',
          'status',
          'archived_at',
          'sort_order',
          'created_at',
        ],
        Prisma.sql`
          SELECT c.id::text AS id, c.kind::text AS kind, c.parent_id::text AS parent_id, c.name,
                 c.color, c.icon, c.is_system::text AS is_system, c.status::text AS status,
                 ${instant('c.archived_at')} AS archived_at, c.sort_order::text AS sort_order,
                 ${instant('c.created_at')} AS created_at
            FROM category c
           WHERE c.user_id = ${userId}::uuid
           ORDER BY c.kind, c.status, c.sort_order, c.id`,
      );
    },

    transactions() {
      return table(
        [
          'id',
          'kind',
          'date',
          'note',
          'category_id',
          'origin',
          'origin_id',
          'parent_transaction_id',
          'rate_cur_bob',
          'rate_usd_bob',
          'declared_rate',
          'created_at',
          'updated_at',
        ],
        Prisma.sql`
          SELECT t.id::text AS id, t.kind::text AS kind, t.date::text AS date, t.note,
                 t.category_id::text AS category_id, t.origin::text AS origin,
                 t.origin_id::text AS origin_id,
                 t.parent_transaction_id::text AS parent_transaction_id,
                 t.rate_cur_bob::text AS rate_cur_bob, t.rate_usd_bob::text AS rate_usd_bob,
                 t.declared_rate::text AS declared_rate,
                 ${instant('t.created_at')} AS created_at,
                 ${instant('t.updated_at')} AS updated_at
            FROM ledger_transaction t
           WHERE t.user_id = ${userId}::uuid AND t.deleted_at IS NULL
           ORDER BY t.date, t.created_at, t.id`,
      );
    },

    entries() {
      return table(
        ['id', 'transaction_id', 'account_id', 'currency_code', 'amount', 'date'],
        Prisma.sql`
          SELECT e.id::text AS id, e.transaction_id::text AS transaction_id,
                 e.account_id::text AS account_id, a.currency_code,
                 e.amount::text AS amount, e.date::text AS date
            FROM ledger_entry e
            JOIN ledger_transaction t ON t.user_id = e.user_id AND t.id = e.transaction_id
            JOIN account a ON a.user_id = e.user_id AND a.id = e.account_id
           WHERE e.user_id = ${userId}::uuid AND t.deleted_at IS NULL
           ORDER BY e.date, t.created_at, e.transaction_id, e.id`,
      );
    },

    shortcuts() {
      return table(
        [
          'id',
          'name',
          'kind',
          'amount',
          'account_id',
          'dest_account_id',
          'category_id',
          'note',
          'sort_order',
        ],
        Prisma.sql`
          SELECT s.id::text AS id, s.name, s.kind::text AS kind, s.amount::text AS amount,
                 s.account_id::text AS account_id, s.dest_account_id::text AS dest_account_id,
                 s.category_id::text AS category_id, s.note, s.sort_order::text AS sort_order
            FROM shortcut s
           WHERE s.user_id = ${userId}::uuid
           ORDER BY s.sort_order, s.id`,
      );
    },
  };
}
