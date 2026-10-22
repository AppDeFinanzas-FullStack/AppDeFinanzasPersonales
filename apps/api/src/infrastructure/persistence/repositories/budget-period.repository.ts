import { Prisma } from '@finanzas/db';
import { Decimal } from 'decimal.js';

import type {
  BudgetPeriodRepository,
  BudgetPeriodRow,
  BudgetPeriodStatus,
  LateAdjustmentRow,
  NewBudgetPeriod,
  NewLateAdjustment,
} from '../../../application/ports/repositories.js';
import type { TransactionClient } from '../unit-of-work.js';

interface PeriodRecord {
  id: string;
  budgetId: string;
  startDate: string;
  endDate: string;
  amount: string;
  carryoverIn: string;
  status: BudgetPeriodStatus;
}

interface LateAdjustmentRecord {
  id: string;
  sourcePeriodId: string;
  amount: string;
  voidedAt: Date | null;
}

const COLUMNS = Prisma.sql`p.id::text AS id, p.budget_id::text AS "budgetId",
               to_char(p.start_date, 'YYYY-MM-DD') AS "startDate",
               to_char(p.end_date, 'YYYY-MM-DD') AS "endDate", p.amount::text AS amount,
               p.carryover_in::text AS "carryoverIn", p.status::text AS status`;

const toRow = (record: PeriodRecord): BudgetPeriodRow => ({
  ...record,
  amount: new Decimal(record.amount),
  carryoverIn: new Decimal(record.carryoverIn),
});

/**
 * Prisma implementation over `budget_period`, `budget_late_adjustment` and `budget_threshold_hit`,
 * always filtered by the user of the transaction (RN-09).
 */
export function createBudgetPeriodRepository(
  tx: TransactionClient,
  userId: string,
): BudgetPeriodRepository {
  return {
    async insert(period: NewBudgetPeriod): Promise<void> {
      await tx.$executeRaw`
        INSERT INTO budget_period (id, user_id, budget_id, start_date, end_date, amount,
                                   carryover_in)
        SELECT ${period.id}::uuid, b.user_id, b.id, ${period.startDate}::date,
               ${period.endDate}::date, ${period.amount.toFixed(2)}::numeric,
               ${period.carryoverIn.toFixed(2)}::numeric
          FROM budget b
         WHERE b.user_id = ${userId}::uuid AND b.id = ${period.budgetId}::uuid`;
    },

    async get(id: string): Promise<BudgetPeriodRow | null> {
      const records = await tx.$queryRaw<PeriodRecord[]>`
        SELECT ${COLUMNS}
          FROM budget_period p
         WHERE p.user_id = ${userId}::uuid AND p.id = ${id}::uuid`;
      const record = records[0];
      return record === undefined ? null : toRow(record);
    },

    async listByBudget(budgetId: string, limit: number): Promise<BudgetPeriodRow[]> {
      const records = await tx.$queryRaw<PeriodRecord[]>`
        SELECT ${COLUMNS}
          FROM budget_period p
         WHERE p.user_id = ${userId}::uuid AND p.budget_id = ${budgetId}::uuid
         ORDER BY p.start_date DESC
         LIMIT ${limit}`;
      return records.map(toRow);
    },

    async insertLateAdjustment(adjustment: NewLateAdjustment): Promise<void> {
      await tx.$executeRaw`
        INSERT INTO budget_late_adjustment (id, user_id, period_id, source_period_id, amount)
        SELECT ${adjustment.id}::uuid, p.user_id, p.id, s.id,
               ${adjustment.amount.toFixed(2)}::numeric
          FROM budget_period p
          JOIN budget_period s
            ON s.user_id = p.user_id AND s.id = ${adjustment.sourcePeriodId}::uuid
         WHERE p.user_id = ${userId}::uuid AND p.id = ${adjustment.periodId}::uuid`;
    },

    async lateAdjustments(periodId: string): Promise<LateAdjustmentRow[]> {
      const records = await tx.$queryRaw<LateAdjustmentRecord[]>`
        SELECT id::text AS id, source_period_id::text AS "sourcePeriodId",
               amount::text AS amount, voided_at AS "voidedAt"
          FROM budget_late_adjustment
         WHERE user_id = ${userId}::uuid AND period_id = ${periodId}::uuid
         ORDER BY created_at, id`;
      return records.map((record) => ({ ...record, amount: new Decimal(record.amount) }));
    },

    async voidLateAdjustments(periodId: string): Promise<void> {
      await tx.$executeRaw`
        UPDATE budget_late_adjustment
           SET voided_at = now()
         WHERE user_id = ${userId}::uuid AND period_id = ${periodId}::uuid
           AND voided_at IS NULL`;
    },

    async recordThresholdHit(periodId: string, threshold: number): Promise<boolean> {
      const inserted = await tx.$executeRaw`
        INSERT INTO budget_threshold_hit (period_id, threshold)
        SELECT p.id, ${threshold}::smallint
          FROM budget_period p
         WHERE p.user_id = ${userId}::uuid AND p.id = ${periodId}::uuid
        ON CONFLICT (period_id, threshold) DO NOTHING`;
      return inserted > 0;
    },

    async spent(budget, period): Promise<Decimal> {
      const scope =
        budget.categoryId === null
          ? Prisma.empty
          : Prisma.sql`AND (c.id = ${budget.categoryId}::uuid
                            OR c.parent_id = ${budget.categoryId}::uuid)`;
      const rows = await tx.$queryRaw<{ spent: string }[]>`
        WITH target AS (SELECT ${budget.currencyCode}::char(3) AS code)
        SELECT COALESCE(-SUM(
                 CASE WHEN a.currency_code = target.code THEN e.amount
                      ELSE round(e.amount * t.rate_cur_bob
                                 / CASE target.code
                                     WHEN 'BOB' THEN 1
                                     WHEN 'USD' THEN t.rate_usd_bob
                                     ELSE user_rate_on(t.user_id, target.code, t.date)
                                   END, 2)
                 END), 0)::text AS spent
          FROM ledger_transaction t
          JOIN category c ON c.user_id = t.user_id AND c.id = t.category_id
          JOIN ledger_entry e ON e.user_id = t.user_id AND e.transaction_id = t.id
          JOIN account a ON a.user_id = e.user_id AND a.id = e.account_id
         CROSS JOIN target
         WHERE t.user_id = ${userId}::uuid
           AND t.deleted_at IS NULL
           AND t.kind = 'expense'
           AND c.system_key IS DISTINCT FROM 'debts'
           AND t.date >= ${period.startDate}::date AND t.date <= ${period.endDate}::date
           ${scope}`;
      return new Decimal(rows[0]?.spent ?? 0);
    },
  };
}
