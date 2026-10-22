import { Decimal } from 'decimal.js';

import type {
  AccountEarmark,
  AllocationOrigin,
  GoalAllocationRepository,
  GoalEarmark,
  GoalHistoryItem,
  NewAllocationEvent,
} from '../../../application/ports/repositories.js';
import type { TransactionClient } from '../unit-of-work.js';

interface HistoryRecord {
  accountId: string;
  amount: string;
  origin: AllocationOrigin;
  date: string;
  createdAt: Date;
  ledgerKind: string | null;
}

/** Prisma implementation over `goal_allocation_event`, filtered by the user of the transaction (RN-09). */
export function createGoalAllocationRepository(
  tx: TransactionClient,
  userId: string,
): GoalAllocationRepository {
  return {
    async insert(event: NewAllocationEvent): Promise<void> {
      await tx.$executeRaw`
        INSERT INTO goal_allocation_event (id, user_id, goal_id, account_id, amount, origin,
                                           related_transaction_id)
        VALUES (${event.id}::uuid, ${userId}::uuid, ${event.goalId}::uuid, ${event.accountId}::uuid,
                ${event.amount.toFixed(2)}::numeric, ${event.origin}::allocation_origin,
                ${event.relatedTransactionId}::uuid)`;
    },

    async earmarkedByAccount(accountId: string): Promise<GoalEarmark[]> {
      const rows = await tx.$queryRaw<{ goalId: string; amount: string }[]>`
        SELECT goal_id::text AS "goalId", sum(amount)::text AS amount
          FROM goal_allocation_event
         WHERE user_id = ${userId}::uuid AND account_id = ${accountId}::uuid
         GROUP BY goal_id`;
      return rows.map((row) => ({ goalId: row.goalId, amount: new Decimal(row.amount) }));
    },

    async earmarkedByGoal(goalId: string): Promise<AccountEarmark[]> {
      const rows = await tx.$queryRaw<{ accountId: string; amount: string }[]>`
        SELECT account_id::text AS "accountId", sum(amount)::text AS amount
          FROM goal_allocation_event
         WHERE user_id = ${userId}::uuid AND goal_id = ${goalId}::uuid
         GROUP BY account_id`;
      return rows.map((row) => ({ accountId: row.accountId, amount: new Decimal(row.amount) }));
    },

    async history(goalId: string): Promise<GoalHistoryItem[]> {
      const rows = await tx.$queryRaw<HistoryRecord[]>`
        SELECT e.account_id::text AS "accountId", e.amount::text AS amount,
               e.origin::text AS origin, (e.created_at AT TIME ZONE 'UTC')::date::text AS date,
               e.created_at AS "createdAt", NULL::text AS "ledgerKind"
          FROM goal_allocation_event e
         WHERE e.user_id = ${userId}::uuid AND e.goal_id = ${goalId}::uuid
        UNION ALL
        SELECT le.account_id::text, le.amount::text, 'dedicated_account', le.date::text,
               le.date::timestamp AT TIME ZONE 'UTC', t.kind::text
          FROM goal g
          JOIN ledger_entry le ON le.user_id = g.user_id AND le.account_id = g.dedicated_account_id
          JOIN ledger_transaction t ON t.id = le.transaction_id AND t.deleted_at IS NULL
         WHERE g.user_id = ${userId}::uuid AND g.id = ${goalId}::uuid
         ORDER BY "createdAt" DESC`;
      return rows.map((row) => ({ ...row, amount: new Decimal(row.amount) }));
    },
  };
}
