import { Prisma } from '@finanzas/db';
import { uuidv7 } from 'uuidv7';

import type {
  OccurrenceStatus,
  RecurringOccurrenceRepository,
  RecurringOccurrenceRow,
} from '../../../application/ports/repositories.js';
import type { TransactionClient } from '../unit-of-work.js';

const COLUMNS = Prisma.sql`
  id::text AS id, rule_id::text AS "ruleId",
  to_char(scheduled_date, 'YYYY-MM-DD') AS "scheduledDate", status::text AS status,
  transaction_id::text AS "transactionId", pending_since AS "pendingSince",
  decided_at AS "decidedAt"`;

/**
 * Prisma implementation over `recurring_occurrence`, always filtered by the user of the
 * transaction (RN-09).
 */
export function createRecurringOccurrenceRepository(
  tx: TransactionClient,
  userId: string,
): RecurringOccurrenceRepository {
  return {
    async insertIfAbsent(ruleId: string, date: string): Promise<RecurringOccurrenceRow | null> {
      const rows = await tx.$queryRaw<RecurringOccurrenceRow[]>`
        INSERT INTO recurring_occurrence (id, user_id, rule_id, scheduled_date, status,
                                          pending_since)
        SELECT ${uuidv7()}::uuid, r.user_id, r.id, ${date}::date, 'pending'::occurrence_status,
               now()
          FROM recurring_rule r
         WHERE r.user_id = ${userId}::uuid AND r.id = ${ruleId}::uuid
        ON CONFLICT (rule_id, scheduled_date) DO NOTHING
        RETURNING ${COLUMNS}`;
      return rows[0] ?? null;
    },

    async get(id: string): Promise<RecurringOccurrenceRow | null> {
      const rows = await tx.$queryRaw<RecurringOccurrenceRow[]>`
        SELECT ${COLUMNS} FROM recurring_occurrence
         WHERE user_id = ${userId}::uuid AND id = ${id}::uuid`;
      return rows[0] ?? null;
    },

    async pending(): Promise<RecurringOccurrenceRow[]> {
      return tx.$queryRaw<RecurringOccurrenceRow[]>`
        SELECT ${COLUMNS} FROM recurring_occurrence
         WHERE user_id = ${userId}::uuid AND status = 'pending'
         ORDER BY scheduled_date ASC, id ASC`;
    },

    async decideIf(
      id: string,
      expectedStatus: OccurrenceStatus,
      newStatus: OccurrenceStatus,
    ): Promise<boolean> {
      const changed = await tx.$executeRaw`
        UPDATE recurring_occurrence
           SET status = ${newStatus}::occurrence_status,
               decided_at = CASE WHEN ${newStatus}::text = 'pending' THEN NULL ELSE now() END
         WHERE user_id = ${userId}::uuid AND id = ${id}::uuid
           AND status = ${expectedStatus}::occurrence_status`;
      return changed > 0;
    },

    async expiredPending(before: Date): Promise<RecurringOccurrenceRow[]> {
      return tx.$queryRaw<RecurringOccurrenceRow[]>`
        SELECT ${COLUMNS} FROM recurring_occurrence
         WHERE user_id = ${userId}::uuid AND status = 'pending'
           AND pending_since < ${before}::timestamptz
         ORDER BY pending_since ASC, id ASC`;
    },
  };
}
