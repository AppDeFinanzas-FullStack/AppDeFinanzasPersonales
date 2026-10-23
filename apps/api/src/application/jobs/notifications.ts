import type { Release } from '@finanzas/contracts';
import { Decimal } from 'decimal.js';

import type { Clock, LocalDate } from '../ports/clock.js';
import type { DebtRow, Repositories } from '../ports/repositories.js';
import type { UnitOfWork } from '../ports/unit-of-work.js';
import {
  createNotificationEmitter,
  type NotificationEmitter,
} from '../shared/notification-emitter.js';

/** A user the job walks, with the timezone of their profile (RNF-20). */
export interface ScheduledUser {
  id: string;
  timezone: string;
}

/** The users the scheduled notifications are evaluated for. */
export interface ScheduledUsers {
  all(): Promise<ScheduledUser[]>;
  /** `null` when there is no such user. */
  find(userId: string): Promise<ScheduledUser | null>;
}

export interface ScheduledNotificationsDeps {
  uow: UnitOfWork;
  clock: Clock;
  release: Release;
  users: ScheduledUsers;
}

/** The batch run of the tick and its per-user scope for `catchUpUser` (ADR-01). */
export interface ScheduledNotifications {
  run(): Promise<void>;
  forUser(userId: string): Promise<void>;
}

/** Local time from which the notices without a configurable hour are generated (RF-M15-09). */
const SCHEDULED_MINUTES = 8 * 60;

/** Days from today to the due date of each debt notice, by its key suffix (RF-M13-14). */
const DEBT_NOTICES = [
  { kind: 'd-3', daysLeft: 3 },
  { kind: 'd0', daysLeft: 0 },
  { kind: 'd+1', daysLeft: -1 },
] as const;

const DAY_MS = 86_400_000;

/** Minutes since local midnight of that instant in the timezone. */
function localMinutes(instant: Date, timezone: string): number {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: timezone,
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(instant);
  const value = (type: 'hour' | 'minute'): number =>
    Number(parts.find((part) => part.type === type)?.value ?? '0');
  return value('hour') * 60 + value('minute');
}

/** Whole days from `from` to `to`, both `YYYY-MM-DD`. */
const daysBetween = (from: LocalDate, to: LocalDate): number =>
  Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY_MS);

/** Today's due notice of the debt, if any: active debts with a balance only (RF-M13-14). */
function noticeOf(debt: DebtRow, today: LocalDate) {
  if (debt.status !== 'active' || debt.dueDate === null) return null;
  const balance = debt.capitalOutstanding.plus(debt.interestUnpaid);
  if (balance.lte(0)) return null;
  const daysLeft = daysBetween(today, debt.dueDate);
  const notice = DEBT_NOTICES.find((candidate) => candidate.daysLeft === daysLeft);
  if (notice === undefined) return null;
  return {
    type: 'payment_upcoming' as const,
    eventKey: `debt:${debt.id}:due:${debt.dueDate}:${notice.kind}`,
    params: {
      debtId: debt.id,
      direction: debt.direction,
      person: debt.person,
      amount: balance.toDecimalPlaces(2, Decimal.ROUND_HALF_UP).toFixed(2),
      currencyCode: debt.currencyCode,
      dueDate: debt.dueDate,
      daysLeft: notice.daysLeft,
    },
    targetRoute: `/deudas/${debt.id}`,
  };
}

async function emitDebtNotices(
  repos: Repositories,
  emitter: NotificationEmitter,
  userId: string,
  today: LocalDate,
): Promise<void> {
  for (const debt of await repos.debts.list()) {
    const notice = noticeOf(debt, today);
    if (notice !== null) {
      await emitter.emit(repos, userId, notice);
    }
  }
}

/**
 * The `notifications.scheduled` job (plan §4.15.3): for each user whose local time already passed
 * 08:00 (RF-M15-09), it creates today's due notices of their active debts in both directions
 * (RF-M13-14). Only today is evaluated, and each notice has a dated `event_key`, so running it
 * again creates nothing new (RNF-12).
 */
export function createScheduledNotifications({
  uow,
  clock,
  release,
  users,
}: ScheduledNotificationsDeps): ScheduledNotifications {
  const emitter = createNotificationEmitter({ release });

  const generate = async (user: ScheduledUser): Promise<void> => {
    if (localMinutes(clock.now(), user.timezone) < SCHEDULED_MINUTES) return;
    const today = clock.todayFor(user.timezone);
    await uow.run((repos) => emitDebtNotices(repos, emitter, user.id, today), {
      userLock: user.id,
    });
  };

  return {
    async run() {
      let failure: Error | null = null;
      for (const user of await users.all()) {
        try {
          await generate(user);
        } catch (error) {
          // One user's failure does not stop the others; the next run completes it (RNF-13).
          failure ??= error instanceof Error ? error : new Error(String(error));
        }
      }
      if (failure !== null) throw failure;
    },

    async forUser(userId) {
      const user = await users.find(userId);
      if (user === null) return;
      await generate(user);
    },
  };
}
