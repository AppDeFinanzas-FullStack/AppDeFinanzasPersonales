import type { LoginThrottleRepository } from '../../../application/ports/repositories.js';
import type { TransactionClient } from '../unit-of-work.js';

/** Prisma implementation of the login throttle of plan §4.1.3, bound to the transaction `tx`. */
export function createLoginThrottleRepository(tx: TransactionClient): LoginThrottleRepository {
  return {
    async remainingSeconds(emailHmac) {
      const rows = await tx.$queryRaw<{ seconds: number }[]>`
        SELECT ceil(extract(epoch FROM locked_until - now()))::int AS seconds
          FROM login_throttle
         WHERE email_hmac = ${emailHmac} AND locked_until > now()`;
      return rows[0]?.seconds ?? 0;
    },

    async recordFailure(emailHmac) {
      await tx.$executeRaw`
        INSERT INTO login_throttle (email_hmac, consecutive_failures, last_failure_at)
        VALUES (${emailHmac}, 1, now())
        ON CONFLICT (email_hmac) DO UPDATE SET
          consecutive_failures = CASE
            WHEN login_throttle.last_failure_at < now() - interval '1 hour' THEN 1
            ELSE login_throttle.consecutive_failures + 1 END,
          locked_until = CASE
            WHEN login_throttle.last_failure_at < now() - interval '1 hour' THEN NULL
            WHEN login_throttle.consecutive_failures + 1 >= 10 THEN now() + interval '15 minutes'
            WHEN login_throttle.consecutive_failures + 1 = 5 THEN now() + interval '1 minute'
            ELSE login_throttle.locked_until END,
          last_failure_at = now()`;
    },

    async reset(emailHmac) {
      await tx.$executeRaw`DELETE FROM login_throttle WHERE email_hmac = ${emailHmac}`;
    },

    async claimAlert(emailHmac) {
      const rows = await tx.$queryRaw<{ emailHmac: string }[]>`
        UPDATE login_throttle SET last_alert_sent_at = now()
         WHERE email_hmac = ${emailHmac}
           AND (last_alert_sent_at IS NULL OR last_alert_sent_at < now() - interval '1 hour')
        RETURNING email_hmac AS "emailHmac"`;
      return rows.length > 0;
    },
  };
}
