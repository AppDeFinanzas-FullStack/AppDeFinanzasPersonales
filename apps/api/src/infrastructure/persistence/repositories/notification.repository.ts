import type {
  NewNotification,
  NotificationRepository,
} from '../../../application/ports/repositories.js';
import type { TransactionClient } from '../unit-of-work.js';

/** Prisma implementation of the `notification` rows of plan §3.7, bound to the transaction `tx`. */
export function createNotificationRepository(tx: TransactionClient): NotificationRepository {
  return {
    async insertIfAbsent({
      id,
      userId,
      type,
      eventKey,
      params,
      targetRoute,
      decision,
    }: NewNotification): Promise<boolean> {
      const decisionKind = decision?.kind ?? null;
      const decisionRef = decision?.ref ?? null;
      const decisionStatus = decision === undefined ? null : 'waiting';
      const inserted = await tx.$executeRaw`
        INSERT INTO notification
               (id, user_id, type, event_key, params, target_route,
                decision_kind, decision_ref, decision_status)
        VALUES (${id}::uuid, ${userId}::uuid, ${type}::notification_type, ${eventKey},
                ${JSON.stringify(params)}::jsonb, ${targetRoute},
                ${decisionKind}, ${decisionRef}::uuid, ${decisionStatus}::decision_status)
        ON CONFLICT (user_id, event_key) DO NOTHING`;
      return inserted === 1;
    },

    async resolveDecision(userId, kind, ref): Promise<number> {
      return tx.$executeRaw`
        UPDATE notification
           SET decision_status = 'resolved'
         WHERE user_id = ${userId}::uuid
           AND decision_kind = ${kind}
           AND decision_ref = ${ref}::uuid
           AND decision_status = 'waiting'`;
    },
  };
}
