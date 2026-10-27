import { Prisma } from '@finanzas/db';
import { Decimal } from 'decimal.js';

import type {
  BudgetPeriodPatch,
  BudgetPeriodRepository,
  BudgetPeriodRow,
  BudgetPeriodStatus,
  ClosedBudgetPeriod,
  LateAdjustmentRow,
  NewBudgetPeriod,
  NewLateAdjustment,
  PeriodDecision,
} from '../../../application/ports/repositories.js';
import type { LocalDate } from '../../../application/ports/clock.js';
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

/** The `SET` assignments of the fields present in the patch. */
function assignments(patch: BudgetPeriodPatch): Prisma.Sql[] {
  const sets: Prisma.Sql[] = [];
  if (patch.endDate !== undefined) {
    sets.push(Prisma.sql`end_date = ${patch.endDate}::date`);
  }
  if (patch.amount !== undefined) {
    sets.push(Prisma.sql`amount = ${patch.amount.toFixed(2)}::numeric`);
  }
  if (patch.carryoverIn !== undefined) {
    sets.push(Prisma.sql`carryover_in = ${patch.carryoverIn.toFixed(2)}::numeric`);
  }
  return sets;
}

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

    async update(id: string, patch: BudgetPeriodPatch): Promise<void> {
      const sets = assignments(patch);
      if (sets.length === 0) {
        return;
      }
      await tx.$executeRaw`
        UPDATE budget_period
           SET ${Prisma.join(sets, ', ')}
         WHERE user_id = ${userId}::uuid AND id = ${id}::uuid`;
    },

    async delete(id: string): Promise<void> {
      await tx.$executeRaw`
        DELETE FROM budget_period WHERE user_id = ${userId}::uuid AND id = ${id}::uuid`;
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

    async current(budgetId: string): Promise<BudgetPeriodRow | null> {
      const records = await tx.$queryRaw<PeriodRecord[]>`
        SELECT ${COLUMNS}
          FROM budget_period p
         WHERE p.user_id = ${userId}::uuid AND p.budget_id = ${budgetId}::uuid
           AND p.status = 'open'
         ORDER BY p.start_date DESC
         LIMIT 1`;
      const record = records[0];
      return record === undefined ? null : toRow(record);
    },

    async listEnded(now: Date): Promise<BudgetPeriodRow[]> {
      const records = await tx.$queryRaw<PeriodRecord[]>`
        SELECT ${COLUMNS}
          FROM budget_period p
          JOIN auth_user u ON u.id = p.user_id
         WHERE p.user_id = ${userId}::uuid AND p.status = 'open'
           AND p.end_date < (${now}::timestamptz AT TIME ZONE u.timezone)::date
         ORDER BY p.start_date, p.id`;
      return records.map(toRow);
    },

    async close(id: string, deadline: Date): Promise<boolean> {
      const updated = await tx.$executeRaw`
        UPDATE budget_period
           SET status = 'closed_pending', decision_deadline = ${deadline}::timestamptz
         WHERE user_id = ${userId}::uuid AND id = ${id}::uuid AND status = 'open'`;
      return updated > 0;
    },

    async decide(id: string, decision: PeriodDecision): Promise<boolean> {
      const updated = await tx.$queryRaw<{ id: string }[]>`
        UPDATE budget_period
           SET status = 'decided', decided_at = now(),
               spent_at_decision = ${decision.spentAtDecision.toFixed(2)}::numeric,
               result_at_decision = ${decision.resultAtDecision.toFixed(2)}::numeric,
               decision = ${JSON.stringify(decision.decision)}::jsonb
         WHERE user_id = ${userId}::uuid AND id = ${id}::uuid AND status = 'closed_pending'
        RETURNING id::text AS id`;
      return updated.length > 0;
    },

    async hasPendingCloseInCategory(categoryId: string): Promise<boolean> {
      const rows = await tx.$queryRaw<{ pending: boolean }[]>`
        SELECT EXISTS (
          SELECT 1
            FROM budget_period p
            JOIN budget b ON b.user_id = p.user_id AND b.id = p.budget_id
           WHERE p.user_id = ${userId}::uuid AND b.category_id = ${categoryId}::uuid
             AND p.status = 'closed_pending'
        ) AS pending`;
      return rows[0]?.pending === true;
    },

    async listOverdue(now: Date): Promise<BudgetPeriodRow[]> {
      const records = await tx.$queryRaw<PeriodRecord[]>`
        SELECT ${COLUMNS}
          FROM budget_period p
         WHERE p.user_id = ${userId}::uuid AND p.status = 'closed_pending'
           AND p.decision_deadline < ${now}::timestamptz
         ORDER BY p.start_date, p.id`;
      return records.map(toRow);
    },

    async applyDefault(id: string, decision: PeriodDecision): Promise<boolean> {
      const updated = await tx.$queryRaw<{ id: string }[]>`
        UPDATE budget_period
           SET status = 'defaulted', decided_at = now(),
               spent_at_decision = ${decision.spentAtDecision.toFixed(2)}::numeric,
               result_at_decision = ${decision.resultAtDecision.toFixed(2)}::numeric,
               decision = ${JSON.stringify(decision.decision)}::jsonb
         WHERE user_id = ${userId}::uuid AND id = ${id}::uuid AND status = 'closed_pending'
        RETURNING id::text AS id`;
      return updated.length > 0;
    },

    async closedContaining(budgetId: string, dates: LocalDate[]): Promise<ClosedBudgetPeriod[]> {
      if (dates.length === 0) {
        return [];
      }
      const records = await tx.$queryRaw<
        {
          id: string;
          startDate: string;
          endDate: string;
          decision: unknown;
          spentAtDecision: string | null;
          adjusted: string;
        }[]
      >`
        SELECT p.id::text AS id, to_char(p.start_date, 'YYYY-MM-DD') AS "startDate",
               to_char(p.end_date, 'YYYY-MM-DD') AS "endDate", p.decision AS decision,
               p.spent_at_decision::text AS "spentAtDecision",
               COALESCE((SELECT SUM(a.amount) FROM budget_late_adjustment a
                          WHERE a.user_id = p.user_id AND a.source_period_id = p.id), 0)::text
                 AS adjusted
          FROM budget_period p
         WHERE p.user_id = ${userId}::uuid AND p.budget_id = ${budgetId}::uuid
           AND p.status IN ('decided', 'defaulted')
           AND EXISTS (SELECT 1 FROM unnest(${dates}::date[]) AS d(day)
                        WHERE d.day BETWEEN p.start_date AND p.end_date)
         ORDER BY p.start_date`;
      return records.map((record) => ({
        ...record,
        spentAtDecision:
          record.spentAtDecision === null ? null : new Decimal(record.spentAtDecision),
        adjusted: new Decimal(record.adjusted),
      }));
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
