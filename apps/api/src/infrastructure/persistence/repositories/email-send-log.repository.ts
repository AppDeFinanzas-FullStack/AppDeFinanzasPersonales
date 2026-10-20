import type { EmailSendLogRepository } from '../../../application/ports/repositories.js';
import type { TransactionClient } from '../unit-of-work.js';

/** Prisma implementation of the send limits log of plan §3.3, bound to the transaction `tx`. */
export function createEmailSendLogRepository(tx: TransactionClient): EmailSendLogRepository {
  return {
    async record(emailHmac, kind) {
      await tx.$executeRaw`
        INSERT INTO email_send_log (email_hmac, kind) VALUES (${emailHmac}, ${kind}::email_kind)`;
    },

    async countSince(emailHmac, kind, seconds) {
      const rows = await tx.$queryRaw<{ n: number }[]>`
        SELECT count(*)::int AS n FROM email_send_log
         WHERE email_hmac = ${emailHmac} AND kind = ${kind}::email_kind
           AND sent_at > now() - make_interval(secs => ${seconds})`;
      return rows[0]?.n ?? 0;
    },
  };
}
