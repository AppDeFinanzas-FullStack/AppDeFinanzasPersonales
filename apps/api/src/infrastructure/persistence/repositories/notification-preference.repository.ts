import type { NotificationPreferenceRepository } from '../../../application/ports/repositories.js';
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
  };
}
