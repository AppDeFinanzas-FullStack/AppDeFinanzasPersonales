import { Decimal } from 'decimal.js';

import type {
  DashboardRepository,
  PeriodTotals,
} from '../../../application/ports/repositories.js';
import type { TransactionClient } from '../unit-of-work.js';

interface TotalsRow {
  curIncome: string;
  curExpense: string;
  prevIncome: string;
  prevExpense: string;
}

const totalsOf = (income: string | undefined, expense: string | undefined): PeriodTotals => ({
  income: new Decimal(income ?? 0),
  expense: new Decimal(expense ?? 0),
});

/**
 * Prisma implementation of the dashboard reads, always filtered by the user of the transaction
 * (RN-09).
 */
export function createDashboardRepository(tx: TransactionClient, userId: string): DashboardRepository {
  return {
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
                 AS "prevExpense"
          FROM counted`;
      const row = rows[0];
      return {
        current: totalsOf(row?.curIncome, row?.curExpense),
        previous: totalsOf(row?.prevIncome, row?.prevExpense),
      };
    },

    async firstMonth() {
      const rows = await tx.$queryRaw<{ month: string | null }[]>`
        SELECT to_char(LEAST(
                 (SELECT MIN(date) FROM ledger_transaction
                   WHERE user_id = ${userId}::uuid AND deleted_at IS NULL),
                 (SELECT MIN(initial_balance_date) FROM account
                   WHERE user_id = ${userId}::uuid)), 'YYYY-MM') AS month`;
      return rows[0]?.month ?? null;
    },
  };
}
