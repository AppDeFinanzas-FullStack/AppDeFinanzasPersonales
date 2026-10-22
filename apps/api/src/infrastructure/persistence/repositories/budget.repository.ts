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
  };
}
