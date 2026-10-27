import { type Release, releasedNotificationTypes } from '@finanzas/contracts';
import { uuidv7 } from 'uuidv7';

import type {
  NotificationDecisionKind,
  NotificationType,
  Repositories,
} from '../ports/repositories.js';

/** A notification produced by an event of a module (plan §4.15.3). */
export interface EmitNotification {
  type: NotificationType;
  /** The event that produces it, e.g. `budget:<id>:2026-10:80` (RN-10). */
  eventKey: string;
  /** Data for the i18n text. */
  params: Record<string, unknown>;
  targetRoute: string;
  /** The decision the notification waits for, when it has one. */
  decision?: { kind: NotificationDecisionKind; ref: string };
}

export interface NotificationEmitterDeps {
  release: Release;
}

export interface NotificationEmitter {
  /**
   * Creates the in-app notification in the transaction of the event, once per `eventKey`
   * (RN-10, RF-M15-04). Nothing is created when the type is not released (RF-M15-07) or the user
   * turned it off (RF-M15-03). It never writes to the email outbox (RF-M15-01).
   */
  emit(tx: Repositories, userId: string, input: EmitNotification): Promise<void>;
  /** Marks as resolved the user's notifications waiting for that decision (plan §4.15.3). */
  resolveDecision(
    tx: Repositories,
    userId: string,
    kind: NotificationDecisionKind,
    ref: string,
  ): Promise<void>;
}

/** The emitter of in-app notifications that modules call inside their transactions (plan §4.15.3). */
export function createNotificationEmitter({ release }: NotificationEmitterDeps): NotificationEmitter {
  const released = new Set<NotificationType>(releasedNotificationTypes(release));

  return {
    async emit(tx, userId, input): Promise<void> {
      if (!released.has(input.type)) {
        return;
      }
      if (!(await tx.notificationPreferences.isEnabled(userId, input.type))) {
        return;
      }
      await tx.notifications.insertIfAbsent({ id: uuidv7(), userId, ...input });
    },

    async resolveDecision(tx, userId, kind, ref): Promise<void> {
      await tx.notifications.resolveDecision(userId, kind, ref);
    },
  };
}
