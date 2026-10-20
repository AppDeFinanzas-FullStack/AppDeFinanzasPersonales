import type { Instant } from '../../application/ports/clock.js';
import type { MaintenanceStore } from '../../application/ports/maintenance-store.js';
import type { PrismaClient } from './prisma-client.js';

/** Prisma implementation of the `MaintenanceStore` port: the deletions of the `maintenance` job. */
export function createMaintenanceStore(prisma: PrismaClient): MaintenanceStore {
  return {
    async deleteUnconfirmedUsers(registeredBefore: Instant): Promise<void> {
      await prisma.$executeRaw`
        DELETE FROM auth_user
         WHERE NOT email_verified
           AND registered_at < ${registeredBefore}::timestamptz`;
    },

    async deleteSendLogs(sentBefore: Instant): Promise<void> {
      await prisma.$executeRaw`
        DELETE FROM email_send_log WHERE sent_at < ${sentBefore}::timestamptz`;
    },

    async deleteLoginThrottles(lastFailureBefore: Instant): Promise<void> {
      await prisma.$executeRaw`
        DELETE FROM login_throttle WHERE last_failure_at < ${lastFailureBefore}::timestamptz`;
    },

    async deleteRemovedTransactions(deletedBefore: Instant): Promise<void> {
      // The entries and the fee of each one go with it by `ON DELETE CASCADE` (plan §3.5).
      await prisma.$executeRaw`
        DELETE FROM ledger_transaction WHERE deleted_at < ${deletedBefore}::timestamptz`;
    },

    async deleteExpiredUndoActions(expiredBefore: Instant): Promise<void> {
      await prisma.$executeRaw`
        DELETE FROM undo_action WHERE expires_at < ${expiredBefore}::timestamptz`;
    },
  };
}
