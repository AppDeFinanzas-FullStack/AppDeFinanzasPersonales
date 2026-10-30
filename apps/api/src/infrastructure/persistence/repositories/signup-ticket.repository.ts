import type { SignupTicketRepository } from '../../../application/ports/repositories.js';
import type { TransactionClient } from '../unit-of-work.js';

/** Prisma implementation of the registration tickets of plan §4.1.2, bound to the transaction `tx`. */
export function createSignupTicketRepository(tx: TransactionClient): SignupTicketRepository {
  return {
    async issue(userId, tokenHash, expiresAt) {
      await tx.$executeRaw`
        INSERT INTO signup_ticket (token_hash, user_id, expires_at)
        VALUES (${tokenHash}, ${userId}::uuid, ${expiresAt}::timestamptz)
        ON CONFLICT (user_id) DO UPDATE
          SET token_hash = EXCLUDED.token_hash, created_at = now(),
              expires_at = EXCLUDED.expires_at, confirmed_at = NULL`;
    },

    async markConfirmed(userId) {
      await tx.$executeRaw`
        UPDATE signup_ticket SET confirmed_at = now()
         WHERE user_id = ${userId}::uuid AND confirmed_at IS NULL`;
    },

    async claim(tokenHash) {
      const rows = await tx.$queryRaw<{ userId: string }[]>`
        DELETE FROM signup_ticket
         WHERE token_hash = ${tokenHash} AND confirmed_at IS NOT NULL AND expires_at > now()
        RETURNING user_id::text AS "userId"`;
      return rows[0]?.userId ?? null;
    },

    async deleteForUser(userId) {
      await tx.$executeRaw`DELETE FROM signup_ticket WHERE user_id = ${userId}::uuid`;
    },

    async purgeExpired(now) {
      await tx.$executeRaw`DELETE FROM signup_ticket WHERE expires_at < ${now}::timestamptz`;
    },
  };
}
