import type { UserRepository } from '../../../application/ports/repositories.js';
import type { TransactionClient } from '../unit-of-work.js';

/** Prisma implementation of the initial rows of a new user, bound to the transaction `tx`. */
export function createUserRepository(tx: TransactionClient): UserRepository {
  return {
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
