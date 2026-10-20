import { uuidv7 } from 'uuidv7';

import type { UserRepository } from '../../../application/ports/repositories.js';
import type { TransactionClient } from '../unit-of-work.js';

/** Prisma implementation of the initial rows of a new user, bound to the transaction `tx`. */
export function createUserRepository(tx: TransactionClient): UserRepository {
  return {
    async findByEmail(email) {
      const rows = await tx.$queryRaw<{ id: string; emailVerified: boolean }[]>`
        SELECT id::text AS id, email_verified AS "emailVerified" FROM auth_user WHERE email = ${email} FOR UPDATE`;
      return rows[0] ?? null;
    },

    async findCredential(email) {
      const rows = await tx.$queryRaw<
        { id: string; emailVerified: boolean; passwordHash: string | null }[]
      >`
        SELECT u.id::text AS id, u.email_verified AS "emailVerified", a.password AS "passwordHash"
          FROM auth_user u
          JOIN auth_account a ON a.user_id = u.id AND a.provider_id = 'credential'
         WHERE u.email = ${email}`;
      const row = rows[0];
      if (row === undefined || row.passwordHash === null) {
        return null;
      }
      return { id: row.id, emailVerified: row.emailVerified, passwordHash: row.passwordHash };
    },

    async createUnconfirmed(user) {
      const rows = await tx.$queryRaw<{ id: string }[]>`
        INSERT INTO auth_user (id, name, email, terms_accepted_at, registered_at)
        VALUES (${user.id}::uuid, ${user.name}, ${user.email}, now(), now())
        ON CONFLICT (email) DO NOTHING
        RETURNING id::text AS id`;
      if (rows.length === 0) {
        return false;
      }
      await tx.$executeRaw`
        INSERT INTO auth_account (id, user_id, account_id, provider_id, password)
        VALUES (${uuidv7()}::uuid, ${user.id}::uuid, ${user.id}, 'credential', ${user.passwordHash})`;
      return true;
    },

    async replaceUnconfirmed(email, name, passwordHash) {
      const rows = await tx.$queryRaw<{ id: string }[]>`
        UPDATE auth_user SET name = ${name}, registered_at = now()
         WHERE email = ${email} AND NOT email_verified
        RETURNING id::text AS id`;
      const id = rows[0]?.id;
      if (id === undefined) {
        return null;
      }
      await tx.$executeRaw`
        UPDATE auth_account SET password = ${passwordHash}
         WHERE user_id = ${id}::uuid AND provider_id = 'credential'`;
      return id;
    },

    async claimRegisterAttempt(emailHmac) {
      const rows = await tx.$queryRaw<{ id: bigint }[]>`
        INSERT INTO email_send_log (email_hmac, kind)
        SELECT ${emailHmac}, 'register_attempt'::email_kind
         WHERE NOT EXISTS (
           SELECT 1 FROM email_send_log
            WHERE email_hmac = ${emailHmac} AND kind = 'register_attempt'::email_kind
              AND sent_at > now() - interval '1 hour')
        RETURNING id`;
      return rows.length > 0;
    },

    async createSystemCurrencies(userId) {
      await tx.$executeRaw`
        INSERT INTO currency (user_id, code, symbol, is_system, status)
        VALUES (${userId}::uuid, 'BOB', 'Bs', true, 'active'),
               (${userId}::uuid, 'USD', '$', true, 'active')`;
    },

    async createSettings(userId, dashboardBlocks) {
      await tx.$executeRaw`
        INSERT INTO user_settings (user_id, dashboard_blocks)
        VALUES (${userId}::uuid, ${JSON.stringify(dashboardBlocks)}::jsonb)`;
    },

    async createCategories(categories) {
      for (const c of categories) {
        await tx.$executeRaw`
          INSERT INTO category
            (id, user_id, kind, parent_id, name, color, icon, is_system, system_key, seed_order, sort_order)
          VALUES
            (${c.id}::uuid, ${c.userId}::uuid, ${c.kind}::category_kind, ${c.parentId}::uuid,
             ${c.name}, ${c.color}, ${c.icon}, ${c.systemKey !== null},
             ${c.systemKey}::system_category_key, ${c.seedOrder}, ${c.sortOrder})`;
      }
    },

    async createNotificationPreferences(userId, preferences) {
      for (const p of preferences) {
        await tx.$executeRaw`
          INSERT INTO notification_preference (user_id, type, enabled, hour, lead_days, weekdays)
          VALUES (${userId}::uuid, ${p.type}::notification_type, ${p.enabled}, ${p.hour},
                  ${p.leadDays}, ${p.weekdays}::smallint[])`;
      }
    },
  };
}
