import type { Instant } from '../../../application/ports/clock.js';
import type {
  DueOutboxEmail,
  EmailOutboxRepository,
  OutboxEmail,
} from '../../../application/ports/repositories.js';
import type { TransactionClient } from '../unit-of-work.js';

interface DueRow {
  id: string;
  toAddress: string;
  kind: OutboxEmail['kind'];
  payload: OutboxEmail['payload'];
  attempts: number;
}

/** Prisma implementation of the email outbox of plan §3.3, bound to the transaction `tx`. */
export function createEmailOutboxRepository(tx: TransactionClient): EmailOutboxRepository {
  return {
    async enqueue({ id, to, kind, payload }: OutboxEmail): Promise<void> {
      await tx.$executeRaw`
        INSERT INTO email_outbox (id, to_address, kind, payload)
        VALUES (${id}::uuid, ${to}, ${kind}::email_kind, ${JSON.stringify(payload)}::jsonb)`;
    },

    async findDue(now: Instant, limit: number): Promise<DueOutboxEmail[]> {
      const rows = await tx.$queryRaw<DueRow[]>`
        SELECT id::text AS id, to_address AS "toAddress", kind::text AS kind, payload, attempts
          FROM email_outbox
         WHERE status = 'pending' AND next_attempt_at <= ${now}::timestamptz
         ORDER BY next_attempt_at, id
         LIMIT ${limit}`;
      return rows.map((row) => ({
        id: row.id,
        to: row.toAddress,
        kind: row.kind,
        payload: row.payload,
        attempts: row.attempts,
      }));
    },

    async remove(id: string): Promise<void> {
      await tx.$executeRaw`DELETE FROM email_outbox WHERE id = ${id}::uuid`;
    },

    async recordFailure(
      id: string,
      attempts: number,
      nextAttemptAt: Instant | null,
      error: string,
    ): Promise<void> {
      if (nextAttemptAt === null) {
        await tx.$executeRaw`
          UPDATE email_outbox
             SET status = 'failed', attempts = ${attempts}, last_error = ${error}
           WHERE id = ${id}::uuid`;
        return;
      }
      await tx.$executeRaw`
        UPDATE email_outbox
           SET attempts = ${attempts}, last_error = ${error},
               next_attempt_at = ${nextAttemptAt}::timestamptz
         WHERE id = ${id}::uuid`;
    },
  };
}
