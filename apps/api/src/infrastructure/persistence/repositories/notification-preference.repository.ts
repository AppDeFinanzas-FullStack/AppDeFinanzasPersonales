import type {
  NotificationPreferenceData,
  NotificationPreferenceRepository,
} from '../../../application/ports/repositories.js';
import type { TransactionClient } from '../unit-of-work.js';

/**
 * Prisma implementation of the `notification_preference` rows of plan §3.7, bound to the
 * transaction `tx`.
 */
export function createNotificationPreferenceRepository(
  tx: TransactionClient,
): NotificationPreferenceRepository {
  return {
    async isEnabled(userId, type): Promise<boolean> {
      const rows = await tx.$queryRaw<{ enabled: boolean }[]>`
        SELECT enabled FROM notification_preference
         WHERE user_id = ${userId}::uuid AND type = ${type}::notification_type`;
      return rows[0]?.enabled === true;
    },

    async list(userId): Promise<NotificationPreferenceData[]> {
      return tx.$queryRaw<NotificationPreferenceData[]>`
        SELECT type::text AS type, enabled, hour::int AS hour, lead_days::int AS "leadDays",
               weekdays::int[] AS weekdays
          FROM notification_preference
         WHERE user_id = ${userId}::uuid
         ORDER BY type`;
    },

    async update(userId, change): Promise<void> {
      const hour = change.hour ?? null;
      const leadDays = change.leadDays ?? null;
      const weekdays = change.weekdays ?? null;
      await tx.$executeRaw`
        UPDATE notification_preference
           SET enabled = ${change.enabled},
               hour = CASE WHEN ${change.hour !== undefined}::boolean
                           THEN ${hour}::smallint ELSE hour END,
               lead_days = CASE WHEN ${change.leadDays !== undefined}::boolean
                                THEN ${leadDays}::smallint ELSE lead_days END,
               weekdays = CASE WHEN ${change.weekdays !== undefined}::boolean
                               THEN ${weekdays}::smallint[] ELSE weekdays END
         WHERE user_id = ${userId}::uuid AND type = ${change.type}::notification_type`;
    },
  };
}
