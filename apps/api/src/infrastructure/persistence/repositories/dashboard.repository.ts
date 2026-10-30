import { Decimal } from 'decimal.js';

import type { DashboardRepository, PeriodTotals } from '../../../application/ports/repositories.js';
import type { PrismaClient } from '../prisma-client.js';
import type { TransactionClient } from '../unit-of-work.js';

interface TotalsRow {
  curIncome: string;
  curExpense: string;
  prevIncome: string;
  prevExpense: string;
  firstMonth: string | null;
}

const totalsOf = (income: string | undefined, expense: string | undefined): PeriodTotals => ({
  income: new Decimal(income ?? 0),
  expense: new Decimal(expense ?? 0),
});

/** Expense of one day and category, in the base currency, as decimal text. */
export interface ExpenseRow {
  date: string;
  /** The top-level category the expense adds to; `null` when it has none. */
  categoryId: string | null;
  name: string | null;
  amount: string;
}

/** Reads of the charts of the dashboard, always filtered by the given user (RN-09). */
export interface DashboardExpenseReader {
  expenses(
    userId: string,
    base: string,
    range: { from: string; to: string },
  ): Promise<ExpenseRow[]>;
}

/**
 * Expenses per day and top-level category (a subcategory adds to its parent, RF-M5-03), converted
 * with the rates each movement stored (RN-05) and without what RN-02 leaves out. The parent is the
 * current one, so moving a subcategory changes the past months (RF-M5-09).
 */
export function createDashboardExpenseReader(prisma: PrismaClient): DashboardExpenseReader {
  return {
    async expenses(userId, base, range) {
      return prisma.$queryRaw<ExpenseRow[]>`
        WITH base AS (SELECT ${base}::char(3) AS code),
        spent AS (
          SELECT t.date,
                 COALESCE(c.parent_id, c.id) AS category_id,
                 -(CASE WHEN a.currency_code = base.code THEN e.amount
                        ELSE round(e.amount * t.rate_cur_bob
                                   / CASE base.code
                                       WHEN 'BOB' THEN 1
                                       WHEN 'USD' THEN t.rate_usd_bob
                                       ELSE user_rate_on(t.user_id, base.code, t.date)
                                     END, 2)
                   END) AS amount
            FROM ledger_transaction t
            LEFT JOIN category c ON c.user_id = t.user_id AND c.id = t.category_id
            JOIN ledger_entry e ON e.user_id = t.user_id AND e.transaction_id = t.id
            JOIN account a ON a.user_id = e.user_id AND a.id = e.account_id
           CROSS JOIN base
           WHERE t.user_id = ${userId}::uuid
             AND t.deleted_at IS NULL
             AND t.kind = 'expense'
             AND c.system_key IS DISTINCT FROM 'debts'
             AND t.date >= ${range.from}::date AND t.date <= ${range.to}::date
        )
        SELECT to_char(s.date, 'YYYY-MM-DD') AS date,
               s.category_id::text AS "categoryId",
               p.name AS name,
               COALESCE(SUM(s.amount), 0)::text AS amount
          FROM spent s
          LEFT JOIN category p ON p.user_id = ${userId}::uuid AND p.id = s.category_id
         GROUP BY s.date, s.category_id, p.name
         ORDER BY s.date`;
    },
  };
}

/**
 * Prisma implementation of the dashboard reads, always filtered by the user of the transaction
 * (RN-09).
 */
export function createDashboardRepository(
  tx: TransactionClient,
  userId: string,
): DashboardRepository {
  return {
    async settings() {
      const rows = await tx.$queryRaw<
        { blocks: { key: string; visible: boolean }[] | null; baseCurrency: string }[]
      >`
        SELECT dashboard_blocks AS blocks, base_currency::text AS "baseCurrency"
          FROM user_settings
         WHERE user_id = ${userId}::uuid`;
      const row = rows[0];
      if (row === undefined) {
        return null;
      }
      return {
        hiddenBlocks: (row.blocks ?? [])
          .filter((block) => !block.visible)
          .map((block) => block.key),
        baseCurrency: row.baseCurrency.trim(),
      };
    },

    async totals(current, previous, base) {
      const rows = await tx.$queryRaw<TotalsRow[]>`
        WITH base AS (SELECT ${base}::char(3) AS code),
        counted AS (
          SELECT t.date, t.kind,
                 CASE WHEN a.currency_code = base.code THEN e.amount
                      ELSE round(e.amount * t.rate_cur_bob
                                 / CASE base.code
                                     WHEN 'BOB' THEN 1
                                     WHEN 'USD' THEN t.rate_usd_bob
                                     ELSE user_rate_on(t.user_id, base.code, t.date)
                                   END, 2)
                 END AS amount
            FROM ledger_transaction t
            LEFT JOIN category c ON c.user_id = t.user_id AND c.id = t.category_id
            JOIN ledger_entry e ON e.user_id = t.user_id AND e.transaction_id = t.id
            JOIN account a ON a.user_id = e.user_id AND a.id = e.account_id
           CROSS JOIN base
           WHERE t.user_id = ${userId}::uuid
             AND t.deleted_at IS NULL
             AND t.kind IN ('expense', 'income')
             AND c.system_key IS DISTINCT FROM 'debts'
             AND ((t.date >= ${current.from}::date AND t.date <= ${current.to}::date)
               OR (t.date >= ${previous.from}::date AND t.date <= ${previous.to}::date))
        )
        SELECT COALESCE(SUM(amount) FILTER (WHERE kind = 'income'
                 AND date >= ${current.from}::date AND date <= ${current.to}::date), 0)::text
                 AS "curIncome",
               COALESCE(-SUM(amount) FILTER (WHERE kind = 'expense'
                 AND date >= ${current.from}::date AND date <= ${current.to}::date), 0)::text
                 AS "curExpense",
               COALESCE(SUM(amount) FILTER (WHERE kind = 'income'
                 AND date >= ${previous.from}::date AND date <= ${previous.to}::date), 0)::text
                 AS "prevIncome",
               COALESCE(-SUM(amount) FILTER (WHERE kind = 'expense'
                 AND date >= ${previous.from}::date AND date <= ${previous.to}::date), 0)::text
                 AS "prevExpense",
               to_char(LEAST(
                 (SELECT MIN(date) FROM ledger_transaction
                   WHERE user_id = ${userId}::uuid AND deleted_at IS NULL),
                 (SELECT MIN(initial_balance_date) FROM account
                   WHERE user_id = ${userId}::uuid)), 'YYYY-MM') AS "firstMonth"
          FROM counted`;
      const row = rows[0];
      return {
        current: totalsOf(row?.curIncome, row?.curExpense),
        previous: totalsOf(row?.prevIncome, row?.prevExpense),
        firstMonth: row?.firstMonth ?? null,
      };
    },
  };
}
