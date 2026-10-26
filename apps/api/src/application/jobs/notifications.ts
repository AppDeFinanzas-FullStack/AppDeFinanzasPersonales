import { isReleased, type Release } from '@finanzas/contracts';
import { Decimal } from 'decimal.js';
import { uuidv7 } from 'uuidv7';

import { clampDay, nextDates } from '../../domain/index.js';
import type { Clock, LocalDate } from '../ports/clock.js';
import type {
  AccountRow,
  DebtRow,
  RecurringRuleRow,
  Repositories,
} from '../ports/repositories.js';
import type { UnitOfWork } from '../ports/unit-of-work.js';
import { createRatesService } from '../services/rates.service.js';
import { emitMonthlyGoalNotices, type GoalRatesReader } from '../shared/goal-milestones.js';
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
  /** The rates of the monthly goal notice; read from the unit of work when absent. */
  rates?: GoalRatesReader;
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

/** Days before its date a recurring payment is announced when the user set none (RF-M15-02). */
const DEFAULT_LEAD_DAYS = 1;

/** Days before the pay day of a card its notice arrives (RF-M15-02). */
const CARD_PAY_LEAD_DAYS = 3;

/** The date `days` calendar days after `date`, both `YYYY-MM-DD`. */
const addDays = (date: LocalDate, days: number): LocalDate =>
  new Date(Date.parse(`${date}T00:00:00Z`) + days * DAY_MS).toISOString().slice(0, 10);

/** `true` when that day of the month falls on the date; a missing day is the last one (RF-M4-08). */
function isMonthDay(date: LocalDate, day: number | null): boolean {
  if (day === null) return false;
  const [year, month, dayOfMonth] = date.split('-').map(Number) as [number, number, number];
  return clampDay(year, month, day) === dayOfMonth;
}

/** Recurring payments: expenses and transfers, weekly or longer, never daily (RF-M15-02). */
const isUpcomingPayment = (rule: RecurringRuleRow): boolean =>
  rule.status === 'active' && rule.kind !== 'income' && rule.frequency.type !== 'daily';

async function leadDaysOf(repos: Repositories, userId: string): Promise<number> {
  const preferences = await repos.notificationPreferences.list(userId);
  const preference = preferences.find((candidate) => candidate.type === 'payment_upcoming');
  return preference?.leadDays ?? DEFAULT_LEAD_DAYS;
}

async function emitRecurringNotices(
  repos: Repositories,
  emitter: NotificationEmitter,
  userId: string,
  today: LocalDate,
): Promise<void> {
  const rules = (await repos.recurringRules.list()).filter(isUpcomingPayment);
  if (rules.length === 0) return;
  const leadDays = await leadDaysOf(repos, userId);
  const date = addDays(today, leadDays);
  for (const rule of rules) {
    if (nextDates(rule, date, 1)[0] !== date) continue;
    const account = await repos.accounts.get(rule.accountId);
    await emitter.emit(repos, userId, {
      type: 'payment_upcoming',
      eventKey: `recurring:${rule.id}:${date}`,
      params: {
        ruleId: rule.id,
        name: rule.name,
        kind: rule.kind,
        // `null` is "monto por definir" (RF-M15-02).
        amount: rule.amount === null ? null : rule.amount.toFixed(2),
        currencyCode: account?.currencyCode ?? null,
        date,
        daysLeft: leadDays,
      },
      targetRoute: '/recurrentes',
    });
  }
}

const cardNotice = (card: AccountRow, kind: 'cut' | 'pay', date: LocalDate, daysLeft: number) => ({
  type: 'payment_upcoming' as const,
  eventKey: `card:${card.id}:${kind}:${date}`,
  params: {
    accountId: card.id,
    name: card.name,
    kind,
    currencyCode: card.currencyCode,
    date,
    daysLeft,
  },
  targetRoute: `/cuentas/${card.id}`,
});

async function emitCardNotices(
  repos: Repositories,
  emitter: NotificationEmitter,
  userId: string,
  today: LocalDate,
): Promise<void> {
  const payDate = addDays(today, CARD_PAY_LEAD_DAYS);
  for (const card of await repos.accounts.list('active')) {
    if (card.type !== 'credit_card') continue;
    if (isMonthDay(today, card.cardCutDay)) {
      await emitter.emit(repos, userId, cardNotice(card, 'cut', today, 0));
    }
    if (isMonthDay(payDate, card.cardPayDay)) {
      await emitter.emit(repos, userId, cardNotice(card, 'pay', payDate, CARD_PAY_LEAD_DAYS));
    }
  }
}

/** Local hour of the `log_day` notice when the user set none (RF-M15-02). */
const DEFAULT_LOG_DAY_HOUR = 21;

/** Every weekday, 0 = Sunday: the `log_day` days when the user set none (RF-M15-02). */
const EVERY_WEEKDAY = [0, 1, 2, 3, 4, 5, 6];

/** Weekday of the date, 0 = Sunday. */
const weekdayOf = (date: LocalDate): number => new Date(`${date}T00:00:00Z`).getUTCDay();

/**
 * The "Registrar el día" notice: with the type active, from its hour and on its weekdays, one per
 * local day, even if the user already registered movements that day (RF-M15-02, EC-M15-03).
 */
async function emitLogDayNotice(
  repos: Repositories,
  emitter: NotificationEmitter,
  userId: string,
  today: LocalDate,
  minutes: number,
): Promise<void> {
  const preferences = await repos.notificationPreferences.list(userId);
  const preference = preferences.find((candidate) => candidate.type === 'log_day');
  if (preference === undefined || !preference.enabled) return;
  const hour = preference.hour ?? DEFAULT_LOG_DAY_HOUR;
  if (minutes < hour * 60) return;
  const weekdays = preference.weekdays ?? EVERY_WEEKDAY;
  if (!weekdays.includes(weekdayOf(today))) return;
  await emitter.emit(repos, userId, {
    type: 'log_day',
    eventKey: `log_day:${today}`,
    params: { date: today },
    targetRoute: '/registrar',
  });
}

/**
 * The `notifications.scheduled` job (plan §4.15.3): for each user whose local time already passed
 * 08:00 (RF-M15-09), it creates today's due notices of their active debts in both directions
 * (RF-M13-14) and, from the V1.2, the upcoming payments of their recurring rules and the cut and pay
 * days of their cards (RF-M15-02, RF-M4-08) and, on day 1, the monthly notice of the goals whose
 * contribution fell short; also from the V1.2, the "Registrar el día" notice at
 * its own hour and weekdays (EC-M15-03). Only today is evaluated, and each notice has a dated
 * `event_key`, so running it again creates nothing new (RNF-12, RF-M15-10, EC-M15-02).
 */
export function createScheduledNotifications({
  uow,
  clock,
  release,
  users,
  rates = createRatesService({ uow }),
}: ScheduledNotificationsDeps): ScheduledNotifications {
  const emitter = createNotificationEmitter({ release });
  // Recurring rules and card days notify from the V1.2, the release of M14 (RF-M4-08).
  const fullReminders = isReleased('M14', release);

  const generate = async (user: ScheduledUser): Promise<void> => {
    const minutes = localMinutes(clock.now(), user.timezone);
    const scheduledDue = minutes >= SCHEDULED_MINUTES;
    // The `log_day` hour may come before 08:00, so with full reminders every tick is evaluated.
    if (!scheduledDue && !fullReminders) return;
    const today = clock.todayFor(user.timezone);
    await uow.run(
      async (repos) => {
        if (scheduledDue) {
          await emitDebtNotices(repos, emitter, user.id, today);
          if (fullReminders) {
            await emitRecurringNotices(repos, emitter, user.id, today);
            await emitCardNotices(repos, emitter, user.id, today);
            const ctx = { userId: user.id, timezone: user.timezone, now: clock.now(), traceId: uuidv7() };
            await emitMonthlyGoalNotices(repos, emitter, rates, ctx, today);
          }
        }
        if (fullReminders) {
          await emitLogDayNotice(repos, emitter, user.id, today, minutes);
        }
      },
      { userLock: user.id },
    );
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
