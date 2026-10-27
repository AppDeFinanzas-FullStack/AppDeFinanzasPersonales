import { AppError } from '../errors.js';
import type {
  NotificationDecisionKind,
  NotificationPreferenceChange,
  NotificationPreferenceData,
  NotificationType,
} from '../ports/repositories.js';
import type { UnitOfWork } from '../ports/unit-of-work.js';

/** A notification of the inbox, as stored (plan §3.7). */
export interface NotificationRecord {
  id: string;
  type: NotificationType;
  params: Record<string, unknown>;
  targetRoute: string;
  createdAt: Date;
  /** `created_at` in UTC with its microseconds, so the cursor keeps the exact moment. */
  createdAtKey: string;
  readAt: Date | null;
  decision: {
    kind: NotificationDecisionKind;
    ref: string;
    status: 'waiting' | 'resolved';
  } | null;
}

/** The position after which a page starts: the last notification of the previous page. */
export interface NotificationCursorKey {
  createdAt: string;
  id: string;
}

/** The `notification` rows of the inbox, always bound to the user of the session (RN-09). */
export interface NotificationsStore {
  /** Up to `limit` notifications, newest first, after `after` (or from the newest one). */
  list(
    userId: string,
    after: NotificationCursorKey | null,
    limit: number,
  ): Promise<NotificationRecord[]>;
  /** How many of the user's notifications are not read. */
  countUnread(userId: string): Promise<number>;
  /** Marks the notification as read, keeping its decision; `false` when the user has no such one. */
  markRead(userId: string, id: string): Promise<boolean>;
  /** Marks every unread notification of the user as read, keeping their decisions. */
  markAllRead(userId: string): Promise<void>;
  /** Deletes the notification; `false` when the user has no such one. */
  remove(userId: string, id: string): Promise<boolean>;
}

export interface NotificationsPage {
  items: NotificationRecord[];
  nextCursor: string | null;
}

export interface NotificationsService {
  /** A page of the user's notifications, newest first (plan §4.15.2). */
  list(
    userId: string,
    query: { cursor?: string | undefined; limit: number },
  ): Promise<NotificationsPage>;
  /** The counter of the bell: only the unread notifications (RF-M15-06). */
  unreadCount(userId: string): Promise<number>;
  /** Also for a notification waiting for a decision; the decision stays in its module (RF-M15-12). */
  markRead(userId: string, id: string): Promise<void>;
  /** Includes the notifications waiting for a decision (RF-M15-12). */
  markAllRead(userId: string): Promise<void>;
  /** Also for a notification waiting for a decision; the decision stays in its module (RF-M15-12). */
  remove(userId: string, id: string): Promise<void>;
}

const CREATED_AT_KEY = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function encodeCursor(record: NotificationRecord): string {
  const key: NotificationCursorKey = { createdAt: record.createdAtKey, id: record.id };
  return Buffer.from(JSON.stringify(key), 'utf8').toString('base64url');
}

function invalidCursor(): AppError {
  return new AppError('VALIDATION_ERROR', { issues: [{ path: 'cursor', code: 'invalid_cursor' }] });
}

function decodeCursor(cursor: string): NotificationCursorKey {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
  } catch {
    throw invalidCursor();
  }
  if (typeof parsed !== 'object' || parsed === null) {
    throw invalidCursor();
  }
  const { createdAt, id } = parsed as Record<string, unknown>;
  if (
    typeof createdAt !== 'string' ||
    typeof id !== 'string' ||
    !CREATED_AT_KEY.test(createdAt) ||
    !UUID.test(id)
  ) {
    throw invalidCursor();
  }
  return { createdAt, id };
}

/** The inbox of in-app notifications (plan §4.15.2); another user's notification answers 404. */
export function createNotificationsService({
  store,
}: {
  store: NotificationsStore;
}): NotificationsService {
  return {
    async list(userId, { cursor, limit }) {
      const after = cursor === undefined ? null : decodeCursor(cursor);
      const records = await store.list(userId, after, limit + 1);
      const items = records.slice(0, limit);
      const last = items[items.length - 1];
      const nextCursor = records.length > limit && last !== undefined ? encodeCursor(last) : null;
      return { items, nextCursor };
    },

    unreadCount(userId) {
      return store.countUnread(userId);
    },

    async markRead(userId, id) {
      if (!(await store.markRead(userId, id))) {
        throw new AppError('NOT_FOUND');
      }
    },

    markAllRead(userId) {
      return store.markAllRead(userId);
    },

    async remove(userId, id) {
      if (!(await store.remove(userId, id))) {
        throw new AppError('NOT_FOUND');
      }
    },
  };
}

export interface NotificationPreferencesService {
  /** The user's preferences, one per type (plan §4.15.2). */
  list(userId: string): Promise<NotificationPreferenceData[]>;
  /** Changes only the given types; the others stay as they are (RF-M15-03). */
  update(userId: string, changes: NotificationPreferenceChange[]): Promise<void>;
}

type PreferenceSetting = 'hour' | 'leadDays' | 'weekdays';

/**
 * The settings each type uses (RF-M15-02, RF-M15-09): `log_day` goes out at its hour on its
 * weekdays, `payment_upcoming` is the one that goes out days before, and the others take none.
 */
const SETTINGS_OF: Record<NotificationType, readonly PreferenceSetting[]> = {
  payment_upcoming: ['leadDays'],
  budget_alert: [],
  period_close: [],
  recurring_pending: [],
  log_day: ['hour', 'weekdays'],
  goal_progress: [],
};

const SETTINGS: readonly PreferenceSetting[] = ['hour', 'leadDays', 'weekdays'];

function assertChanges(changes: NotificationPreferenceChange[]): void {
  const issues: { path: string; code: string }[] = [];
  const seen = new Set<NotificationType>();
  changes.forEach((change, index) => {
    if (seen.has(change.type)) {
      issues.push({ path: `${index}.type`, code: 'duplicate_type' });
    }
    seen.add(change.type);
    for (const setting of SETTINGS) {
      if (change[setting] !== undefined && !SETTINGS_OF[change.type].includes(setting)) {
        issues.push({ path: `${index}.${setting}`, code: 'not_used_by_type' });
      }
    }
  });
  if (issues.length > 0) {
    throw new AppError('VALIDATION_ERROR', { issues });
  }
}

/** `/api/notification-preferences` (plan §4.15.2), always bound to the user of the session. */
export function createNotificationPreferencesService({
  uow,
}: {
  uow: UnitOfWork;
}): NotificationPreferencesService {
  return {
    list(userId) {
      return uow.run((repos) => repos.notificationPreferences.list(userId), { readOnly: true });
    },

    async update(userId, changes) {
      assertChanges(changes);
      await uow.run(
        async (repos) => {
          for (const change of changes) {
            await repos.notificationPreferences.update(userId, change);
          }
        },
        { userLock: userId },
      );
    },
  };
}
