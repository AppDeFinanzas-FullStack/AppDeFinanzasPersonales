import { randomUUID } from 'node:crypto';

import type {
  ConsumeEmailLinkResult,
  EmailLinkPurpose,
  EmailLinkRepository,
} from '../../../application/ports/repositories.js';
import {
  EMAIL_LINK_LIFETIME_SECONDS,
  generateEmailLinkToken,
  hashEmailLinkToken,
} from '../../../application/shared/email-links.js';
import type { TransactionClient } from '../unit-of-work.js';

interface ConsumedRow {
  userId: string;
  purpose: EmailLinkPurpose;
}

/** Prisma implementation of the email links of plan §4.1.3, bound to the transaction `tx`. */
export function createEmailLinkRepository(tx: TransactionClient): EmailLinkRepository {
  return {
    async create(userId, purpose) {
      await tx.$executeRaw`
        UPDATE email_link SET invalidated_at = now()
         WHERE user_id = ${userId}::uuid AND purpose = ${purpose}::email_link_purpose
           AND used_at IS NULL AND invalidated_at IS NULL`;

      const token = generateEmailLinkToken();
      const rows = await tx.$queryRaw<{ expiresAt: Date }[]>`
        INSERT INTO email_link (id, user_id, purpose, token_hash, expires_at)
        VALUES (${randomUUID()}::uuid, ${userId}::uuid, ${purpose}::email_link_purpose,
                ${hashEmailLinkToken(token)},
                now() + make_interval(secs => ${EMAIL_LINK_LIFETIME_SECONDS[purpose]}))
        RETURNING expires_at AS "expiresAt"`;
      const expiresAt = rows[0]?.expiresAt;
      if (expiresAt === undefined) {
        throw new Error('The email link was not stored');
      }
      return { token, expiresAt };
    },

    async consume(token, purpose): Promise<ConsumeEmailLinkResult> {
      const tokenHash = hashEmailLinkToken(token);
      const consumed = await tx.$queryRaw<ConsumedRow[]>`
        UPDATE email_link SET used_at = now()
         WHERE token_hash = ${tokenHash} AND purpose = ${purpose}::email_link_purpose
           AND used_at IS NULL AND invalidated_at IS NULL AND expires_at > now()
        RETURNING user_id::text AS "userId", purpose::text AS purpose`;
      const row = consumed[0];
      if (row !== undefined) {
        return { ok: true, userId: row.userId, purpose: row.purpose };
      }

      const used = await tx.$queryRaw<{ id: string }[]>`
        SELECT id::text AS id FROM email_link
         WHERE token_hash = ${tokenHash} AND purpose = ${purpose}::email_link_purpose
           AND used_at IS NOT NULL`;
      return { ok: false, reason: used.length > 0 ? 'LINK_ALREADY_USED' : 'LINK_INVALID' };
    },
  };
}
