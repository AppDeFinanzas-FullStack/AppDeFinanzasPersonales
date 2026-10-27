import { Prisma } from '@finanzas/db';
import { Decimal } from 'decimal.js';

import type {
  GoalPatch,
  GoalRepository,
  GoalRow,
  NewGoal,
} from '../../../application/ports/repositories.js';
import type { TransactionClient } from '../unit-of-work.js';

interface GoalRecord {
  id: string;
  name: string;
  target: string;
  currencyCode: string;
  targetDate: string | null;
  icon: string;
  color: string;
  dedicatedAccountId: string | null;
  celebratedAt: Date | null;
  archivedAt: Date | null;
}

const COLUMNS = Prisma.sql`g.id::text AS id, g.name, g.target::text AS target,
               g.currency_code::text AS "currencyCode", g.target_date::text AS "targetDate",
               g.icon, g.color, g.dedicated_account_id::text AS "dedicatedAccountId",
               g.celebrated_at AS "celebratedAt", g.archived_at AS "archivedAt"`;

const toRow =(record: GoalRecord): GoalRow => ({
  ...record,
  target: new Decimal(record.target),
});

/** The `SET` assignments of the fields present in the patch. */
function assignments(patch: GoalPatch): Prisma.Sql[] {
  const sets: Prisma.Sql[] = [];
  if (patch.name !== undefined) sets.push(Prisma.sql`name = ${patch.name}`);
  if (patch.target !== undefined) {
    sets.push(Prisma.sql`target = ${patch.target.toFixed(2)}::numeric`);
  }
  if (patch.currencyCode !== undefined) {
    sets.push(Prisma.sql`currency_code = ${patch.currencyCode}`);
  }
  if (patch.targetDate !== undefined) {
    sets.push(Prisma.sql`target_date = ${patch.targetDate}::date`);
  }
  if (patch.icon !== undefined) sets.push(Prisma.sql`icon = ${patch.icon}`);
  if (patch.color !== undefined) sets.push(Prisma.sql`color = ${patch.color}`);
  return sets;
}

/** Prisma implementation over `goal`, always filtered by the user of the transaction (RN-09). */
export function createGoalRepository(tx: TransactionClient, userId: string): GoalRepository {
  return {
    async insert(goal: NewGoal): Promise<void> {
      await tx.$executeRaw`
        INSERT INTO goal (id, user_id, name, target, currency_code, target_date, icon, color,
                          dedicated_account_id)
        VALUES (${goal.id}::uuid, ${userId}::uuid, ${goal.name}, ${goal.target.toFixed(2)}::numeric,
                ${goal.currencyCode}, ${goal.targetDate}::date, ${goal.icon}, ${goal.color},
                ${goal.dedicatedAccountId}::uuid)`;
    },

    async get(id: string): Promise<GoalRow | null> {
      const records = await tx.$queryRaw<GoalRecord[]>`
        SELECT ${COLUMNS}
          FROM goal g
         WHERE g.user_id = ${userId}::uuid AND g.id = ${id}::uuid`;
      const record = records[0];
      return record === undefined ? null : toRow(record);
    },

    async count(): Promise<number> {
      const rows = await tx.$queryRaw<{ n: number }[]>`
        SELECT count(*)::int AS n FROM goal WHERE user_id = ${userId}::uuid`;
      return rows[0]?.n ?? 0;
    },

    async list(): Promise<GoalRow[]> {
      const records = await tx.$queryRaw<GoalRecord[]>`
        SELECT ${COLUMNS}
          FROM goal g
         WHERE g.user_id = ${userId}::uuid AND g.archived_at IS NULL
         ORDER BY g.created_at, g.id`;
      return records.map(toRow);
    },

    async findByDedicatedAccount(accountId: string): Promise<GoalRow | null> {
      const records = await tx.$queryRaw<GoalRecord[]>`
        SELECT ${COLUMNS}
          FROM goal g
         WHERE g.user_id = ${userId}::uuid AND g.dedicated_account_id = ${accountId}::uuid`;
      const record = records[0];
      return record === undefined ? null : toRow(record);
    },

    async setDedicatedAccount(id: string, accountId: string): Promise<void> {
      await tx.$executeRaw`
        UPDATE goal
           SET dedicated_account_id = ${accountId}::uuid, updated_at = now()
         WHERE user_id = ${userId}::uuid AND id = ${id}::uuid`;
    },

    async clearDedicatedAccount(id: string): Promise<void> {
      await tx.$executeRaw`
        UPDATE goal
           SET dedicated_account_id = NULL, updated_at = now()
         WHERE user_id = ${userId}::uuid AND id = ${id}::uuid`;
    },

    async setArchived(id: string, archived: boolean): Promise<void> {
      await tx.$executeRaw`
        UPDATE goal
           SET archived_at = CASE WHEN ${archived} THEN now() ELSE NULL END, updated_at = now()
         WHERE user_id = ${userId}::uuid AND id = ${id}::uuid`;
    },

    async markCelebrated(id: string): Promise<void> {
      await tx.$executeRaw`
        UPDATE goal
           SET celebrated_at = now(), updated_at = now()
         WHERE user_id = ${userId}::uuid AND id = ${id}::uuid AND celebrated_at IS NULL`;
    },

    async remove(id: string): Promise<void> {
      await tx.$executeRaw`
        DELETE FROM goal WHERE user_id = ${userId}::uuid AND id = ${id}::uuid`;
    },

    async update(id: string, patch: GoalPatch): Promise<void> {
      const sets = assignments(patch);
      if (sets.length === 0) {
        return;
      }
      await tx.$executeRaw`
        UPDATE goal
           SET ${Prisma.join(sets, ', ')}, updated_at = now()
         WHERE user_id = ${userId}::uuid AND id = ${id}::uuid`;
    },
  };
}
