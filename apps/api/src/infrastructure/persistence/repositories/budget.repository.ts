import { Prisma } from '@finanzas/db';
import { Decimal } from 'decimal.js';

import type {
  BudgetDefaultAction,
  BudgetPatch,
  BudgetRepository,
  BudgetRow,
  BudgetScope,
  BudgetStatus,
  NewBudget,
  PendingClosePeriod,
  SystemCategoryKey,
} from '../../../application/ports/repositories.js';
import type { TransactionClient } from '../unit-of-work.js';

interface BudgetRecord {
  id: string;
  scope: BudgetScope;
  categoryId: string | null;
  amount: string;
  currencyCode: string;
  startDay: number;
  nextStartDay: number | null;
  defaultAction: BudgetDefaultAction;
  thresholds: number[];
  status: BudgetStatus;
  frozenCarryover: string | null;
}

const COLUMNS = Prisma.sql`b.id::text AS id, b.scope::text AS scope,
               b.category_id::text AS "categoryId", b.amount::text AS amount,
               b.currency_code::text AS "currencyCode", b.start_day::int AS "startDay",
               b.next_start_day::int AS "nextStartDay", b.default_action::text AS "defaultAction",
               b.thresholds::int[] AS thresholds, b.status::text AS status,
               b.frozen_carryover::text AS "frozenCarryover"`;

const toRow = (record: BudgetRecord): BudgetRow => ({
  ...record,
  amount: new Decimal(record.amount),
  frozenCarryover: record.frozenCarryover === null ? null : new Decimal(record.frozenCarryover),
});

/** The `SET` assignments of the fields present in the patch. */
function assignments(patch: BudgetPatch): Prisma.Sql[] {
  const sets: Prisma.Sql[] = [];
  if (patch.amount !== undefined) {
    sets.push(Prisma.sql`amount = ${patch.amount.toFixed(2)}::numeric`);
  }
  if (patch.defaultAction !== undefined) {
    sets.push(Prisma.sql`default_action = ${patch.defaultAction}::budget_default_action`);
  }
  if (patch.thresholds !== undefined) {
    sets.push(Prisma.sql`thresholds = ${patch.thresholds}::smallint[]`);
  }
  if (patch.nextStartDay !== undefined) {
    sets.push(Prisma.sql`next_start_day = ${patch.nextStartDay}::smallint`);
  }
  if (patch.status !== undefined) {
    sets.push(Prisma.sql`status = ${patch.status}::budget_status`);
  }
  if (patch.frozenCarryover !== undefined) {
    const value = patch.frozenCarryover === null ? null : patch.frozenCarryover.toFixed(2);
    sets.push(Prisma.sql`frozen_carryover = ${value}::numeric`);
  }
  return sets;
}

/** Prisma implementation over `budget`, always filtered by the user of the transaction (RN-09). */
export function createBudgetRepository(tx: TransactionClient, userId: string): BudgetRepository {
  return {
    async insert(budget: NewBudget): Promise<void> {
      await tx.$executeRaw`
        INSERT INTO budget (id, user_id, scope, category_id, amount, currency_code, start_day,
                            default_action, thresholds)
        VALUES (${budget.id}::uuid, ${userId}::uuid, ${budget.scope}::budget_scope,
                ${budget.categoryId}::uuid, ${budget.amount.toFixed(2)}::numeric,
                ${budget.currencyCode}, ${budget.startDay}::smallint,
                ${budget.defaultAction}::budget_default_action,
                ${budget.thresholds}::smallint[])`;
    },

    async get(id: string): Promise<BudgetRow | null> {
      const records = await tx.$queryRaw<BudgetRecord[]>`
        SELECT ${COLUMNS}
          FROM budget b
         WHERE b.user_id = ${userId}::uuid AND b.id = ${id}::uuid`;
      const record = records[0];
      return record === undefined ? null : toRow(record);
    },

    async update(id: string, patch: BudgetPatch): Promise<void> {
      const sets = assignments(patch);
      if (sets.length === 0) {
        return;
      }
      await tx.$executeRaw`
        UPDATE budget
           SET ${Prisma.join(sets, ', ')}, updated_at = now()
         WHERE user_id = ${userId}::uuid AND id = ${id}::uuid`;
    },

    async delete(id: string): Promise<void> {
      await tx.$executeRaw`
        DELETE FROM budget WHERE user_id = ${userId}::uuid AND id = ${id}::uuid`;
    },

    async count(): Promise<number> {
      const rows = await tx.$queryRaw<{ n: number }[]>`
        SELECT count(*)::int AS n FROM budget WHERE user_id = ${userId}::uuid`;
      return rows[0]?.n ?? 0;
    },

    async list(): Promise<BudgetRow[]> {
      const records = await tx.$queryRaw<BudgetRecord[]>`
        SELECT ${COLUMNS}
          FROM budget b
         WHERE b.user_id = ${userId}::uuid
         ORDER BY b.created_at, b.id`;
      return records.map(toRow);
    },

    async findLive(categoryId: string | null): Promise<string | null> {
      const scope =
        categoryId === null
          ? Prisma.sql`b.scope = 'general'`
          : Prisma.sql`b.scope = 'category' AND b.category_id = ${categoryId}::uuid`;
      const rows = await tx.$queryRaw<{ id: string }[]>`
        SELECT b.id::text AS id
          FROM budget b
         WHERE b.user_id = ${userId}::uuid AND ${scope}
           AND b.status IN ('active', 'paused', 'finalizing')
         LIMIT 1`;
      return rows[0]?.id ?? null;
    },

    async categorySystemKey(categoryId: string): Promise<SystemCategoryKey | null> {
      const rows = await tx.$queryRaw<{ systemKey: SystemCategoryKey | null }[]>`
        SELECT system_key::text AS "systemKey"
          FROM category
         WHERE user_id = ${userId}::uuid AND id = ${categoryId}::uuid`;
      return rows[0]?.systemKey ?? null;
    },

    async pendingClose(budgetId: string): Promise<PendingClosePeriod | null> {
      const records = await tx.$queryRaw<
        {
          id: string;
          startDate: string;
          endDate: string;
          amount: string;
          carryoverIn: string;
          deadline: Date | null;
        }[]
      >`
        SELECT p.id::text AS id, to_char(p.start_date, 'YYYY-MM-DD') AS "startDate",
               to_char(p.end_date, 'YYYY-MM-DD') AS "endDate", p.amount::text AS amount,
               p.carryover_in::text AS "carryoverIn", p.decision_deadline AS deadline
          FROM budget_period p
         WHERE p.user_id = ${userId}::uuid AND p.budget_id = ${budgetId}::uuid
           AND p.status = 'closed_pending'
         ORDER BY p.start_date DESC
         LIMIT 1`;
      const record = records[0];
      return record === undefined
        ? null
        : {
            ...record,
            amount: new Decimal(record.amount),
            carryoverIn: new Decimal(record.carryoverIn),
          };
    },

    async listAffected(categoryIds: string[]): Promise<BudgetRow[]> {
      if (categoryIds.length === 0) {
        return [];
      }
      const records = await tx.$queryRaw<BudgetRecord[]>`
        SELECT ${COLUMNS}
          FROM budget b
         WHERE b.user_id = ${userId}::uuid
           AND (b.scope = 'general'
                OR b.category_id = ANY(${categoryIds}::uuid[])
                OR b.category_id IN (
                     SELECT c.parent_id FROM category c
                      WHERE c.user_id = ${userId}::uuid AND c.id = ANY(${categoryIds}::uuid[])
                        AND c.parent_id IS NOT NULL))
         ORDER BY b.created_at, b.id`;
      return records.map(toRow);
    },

    async usesCurrency(code: string): Promise<boolean> {
      const rows = await tx.$queryRaw<{ used: boolean }[]>`
        SELECT EXISTS (
          SELECT 1 FROM budget
           WHERE user_id = ${userId}::uuid AND currency_code = ${code}
             AND status IN ('active', 'paused')
        ) AS used`;
      return rows[0]?.used === true;
    },
  };
}
