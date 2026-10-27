import { Prisma } from '@finanzas/db';

import type { ExportTable } from '../../../application/ports/repositories.js';
import type { ReleaseExportRepository } from '../../../application/services/export.service.js';
import type { TransactionClient } from '../unit-of-work.js';

/** An instant column in ISO 8601 UTC; `column` is always a constant of this file. */
const instant = (column: string): Prisma.Sql =>
  Prisma.raw(`to_char(${column} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`);

/**
 * Prisma implementation over the V1.0, V1.1 and V1.2 tables, always filtered by the user of the
 * transaction (RN-09). Every column is read as text, so decimals keep their exact value (ADR-03).
 */
export function createExportRepository(
  tx: TransactionClient,
  userId: string,
): ReleaseExportRepository {
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

    budgets() {
      return table(
        [
          'id',
          'scope',
          'category_id',
          'amount',
          'currency_code',
          'start_day',
          'next_start_day',
          'default_action',
          'thresholds',
          'status',
          'frozen_carryover',
          'created_at',
          'updated_at',
        ],
        Prisma.sql`
          SELECT b.id::text AS id, b.scope::text AS scope, b.category_id::text AS category_id,
                 b.amount::text AS amount, b.currency_code, b.start_day::text AS start_day,
                 b.next_start_day::text AS next_start_day,
                 b.default_action::text AS default_action, b.thresholds::text AS thresholds,
                 b.status::text AS status, b.frozen_carryover::text AS frozen_carryover,
                 ${instant('b.created_at')} AS created_at,
                 ${instant('b.updated_at')} AS updated_at
            FROM budget b
           WHERE b.user_id = ${userId}::uuid
           ORDER BY b.created_at, b.id`,
      );
    },

    budgetPeriods() {
      return table(
        [
          'id',
          'budget_id',
          'start_date',
          'end_date',
          'amount',
          'carryover_in',
          'status',
          'spent_at_decision',
          'result_at_decision',
          'decision',
          'decision_deadline',
          'decided_at',
        ],
        Prisma.sql`
          SELECT p.id::text AS id, p.budget_id::text AS budget_id,
                 p.start_date::text AS start_date, p.end_date::text AS end_date,
                 p.amount::text AS amount, p.carryover_in::text AS carryover_in,
                 p.status::text AS status, p.spent_at_decision::text AS spent_at_decision,
                 p.result_at_decision::text AS result_at_decision, p.decision::text AS decision,
                 ${instant('p.decision_deadline')} AS decision_deadline,
                 ${instant('p.decided_at')} AS decided_at
            FROM budget_period p
           WHERE p.user_id = ${userId}::uuid
           ORDER BY p.budget_id, p.start_date, p.id`,
      );
    },

    goals() {
      return table(
        [
          'id',
          'name',
          'target',
          'currency_code',
          'target_date',
          'icon',
          'color',
          'dedicated_account_id',
          'celebrated_at',
          'archived_at',
          'created_at',
          'updated_at',
        ],
        Prisma.sql`
          SELECT g.id::text AS id, g.name, g.target::text AS target, g.currency_code,
                 g.target_date::text AS target_date, g.icon, g.color,
                 g.dedicated_account_id::text AS dedicated_account_id,
                 ${instant('g.celebrated_at')} AS celebrated_at,
                 ${instant('g.archived_at')} AS archived_at,
                 ${instant('g.created_at')} AS created_at,
                 ${instant('g.updated_at')} AS updated_at
            FROM goal g
           WHERE g.user_id = ${userId}::uuid
           ORDER BY g.created_at, g.id`,
      );
    },

    goalAllocations() {
      return table(
        ['id', 'goal_id', 'account_id', 'amount', 'origin', 'related_transaction_id', 'created_at'],
        Prisma.sql`
          SELECT e.id::text AS id, e.goal_id::text AS goal_id, e.account_id::text AS account_id,
                 e.amount::text AS amount, e.origin::text AS origin,
                 e.related_transaction_id::text AS related_transaction_id,
                 ${instant('e.created_at')} AS created_at
            FROM goal_allocation_event e
           WHERE e.user_id = ${userId}::uuid
           ORDER BY e.goal_id, e.created_at, e.id`,
      );
    },

    debts() {
      return table(
        [
          'id',
          'direction',
          'person',
          'principal',
          'currency_code',
          'start_date',
          'due_date',
          'note',
          'interest_rate',
          'interest_period',
          'status',
          'forgiven_amount',
          'initial_transaction_id',
          'capital_outstanding',
          'interest_unpaid',
          'accrued_through',
          'created_at',
          'updated_at',
        ],
        Prisma.sql`
          SELECT d.id::text AS id, d.direction::text AS direction, d.person,
                 d.principal::text AS principal, d.currency_code,
                 d.start_date::text AS start_date, d.due_date::text AS due_date, d.note,
                 d.interest_rate::text AS interest_rate,
                 d.interest_period::text AS interest_period, d.status::text AS status,
                 d.forgiven_amount::text AS forgiven_amount,
                 d.initial_transaction_id::text AS initial_transaction_id,
                 d.capital_outstanding::text AS capital_outstanding,
                 d.interest_unpaid::text AS interest_unpaid,
                 d.accrued_through::text AS accrued_through,
                 ${instant('d.created_at')} AS created_at,
                 ${instant('d.updated_at')} AS updated_at
            FROM debt d
           WHERE d.user_id = ${userId}::uuid
           ORDER BY d.created_at, d.id`,
      );
    },

    debtPayments() {
      return table(
        [
          'id',
          'debt_id',
          'amount',
          'interest_part',
          'capital_part',
          'date',
          'account_id',
          'declared_rate',
          'account_amount',
          'capital_transaction_id',
          'interest_transaction_id',
          'note',
          'created_at',
        ],
        Prisma.sql`
          SELECT p.id::text AS id, p.debt_id::text AS debt_id, p.amount::text AS amount,
                 p.interest_part::text AS interest_part, p.capital_part::text AS capital_part,
                 p.date::text AS date, p.account_id::text AS account_id,
                 p.declared_rate::text AS declared_rate,
                 p.account_amount::text AS account_amount,
                 p.capital_transaction_id::text AS capital_transaction_id,
                 p.interest_transaction_id::text AS interest_transaction_id, p.note,
                 ${instant('p.created_at')} AS created_at
            FROM debt_payment p
           WHERE p.user_id = ${userId}::uuid
           ORDER BY p.debt_id, p.date, p.created_at, p.id`,
      );
    },

    notifications() {
      return table(
        [
          'id',
          'type',
          'event_key',
          'params',
          'target_route',
          'decision_kind',
          'decision_ref',
          'decision_status',
          'read_at',
          'created_at',
        ],
        Prisma.sql`
          SELECT n.id::text AS id, n.type::text AS type, n.event_key, n.params::text AS params,
                 n.target_route, n.decision_kind, n.decision_ref::text AS decision_ref,
                 n.decision_status::text AS decision_status,
                 ${instant('n.read_at')} AS read_at,
                 ${instant('n.created_at')} AS created_at
            FROM notification n
           WHERE n.user_id = ${userId}::uuid
           ORDER BY n.created_at, n.id`,
      );
    },
    recurringRules() {
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
          'frequency',
          'weekday',
          'day_of_month',
          'month',
          'start_date',
          'end_type',
          'end_date',
          'end_count',
          'mode',
          'status',
          'paused_at',
          'generated_count',
          'last_generated_date',
          'created_at',
          'updated_at',
        ],
        Prisma.sql`
          SELECT r.id::text AS id, r.name, r.kind::text AS kind, r.amount::text AS amount,
                 r.account_id::text AS account_id, r.dest_account_id::text AS dest_account_id,
                 r.category_id::text AS category_id, r.note, r.frequency::text AS frequency,
                 r.weekday::text AS weekday, r.day_of_month::text AS day_of_month,
                 r.month::text AS month, r.start_date::text AS start_date,
                 r.end_type::text AS end_type, r.end_date::text AS end_date,
                 r.end_count::text AS end_count, r.mode::text AS mode, r.status::text AS status,
                 ${instant('r.paused_at')} AS paused_at,
                 r.generated_count::text AS generated_count,
                 r.last_generated_date::text AS last_generated_date,
                 ${instant('r.created_at')} AS created_at,
                 ${instant('r.updated_at')} AS updated_at
            FROM recurring_rule r
           WHERE r.user_id = ${userId}::uuid
           ORDER BY r.created_at, r.id`,
      );
    },

    recurringOccurrences() {
      return table(
        [
          'id',
          'rule_id',
          'scheduled_date',
          'status',
          'transaction_id',
          'pending_since',
          'decided_at',
        ],
        Prisma.sql`
          SELECT o.id::text AS id, o.rule_id::text AS rule_id,
                 o.scheduled_date::text AS scheduled_date, o.status::text AS status,
                 o.transaction_id::text AS transaction_id,
                 ${instant('o.pending_since')} AS pending_since,
                 ${instant('o.decided_at')} AS decided_at
            FROM recurring_occurrence o
           WHERE o.user_id = ${userId}::uuid
           ORDER BY o.rule_id, o.scheduled_date, o.id`,
      );
    },
  };
}
