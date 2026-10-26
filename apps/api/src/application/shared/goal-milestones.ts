import {
  BOLIVIA_TIME_ZONE,
  progress as goalProgress,
  suggestedMonthly,
  todayFor,
  toMoneyString,
} from '@finanzas/domain';
import { Decimal } from 'decimal.js';
import { uuidv7 } from 'uuidv7';

import { AppError } from '../errors.js';
import type { Clock, LocalDate } from '../ports/clock.js';
import type { GoalRow, Repositories } from '../ports/repositories.js';
import type { UnitOfWork } from '../ports/unit-of-work.js';
import type { RatesContext, RatesService } from '../services/rates.service.js';
import type { LedgerChangeHandler } from './ledger-hooks.js';
import type { NotificationEmitter } from './notification-emitter.js';
import type { UserTimezones } from './recurring-generator.js';

/** The progress milestones of a goal, in percent (RF-M15-02). */
export const GOAL_MILESTONES = [25, 50, 75, 100] as const;

/** The rates read inside the caller's transaction. */
export type GoalRatesReader = Pick<RatesService, 'ratesForMovement'>;

/** A user with goal notices turned on, with the timezone of their profile (RNF-20). */
export interface GoalNoticeUser {
  id: string;
  timezone: string;
}

/** The users the hourly rates job evaluates milestones for. */
export interface GoalNoticeUsers {
  withGoalNotices(): Promise<GoalNoticeUser[]>;
}

export interface GoalMilestonesDeps {
  uow: UnitOfWork;
  rates: GoalRatesReader;
  notifications: NotificationEmitter;
  timezones: UserTimezones;
  users: GoalNoticeUsers;
  clock: Clock;
}

export interface GoalMilestones {
  /** Emits the milestones the goal reached, inside the caller's transaction (plan §4.12.3). */
  evaluate(tx: Repositories, ctx: RatesContext, goalId: string): Promise<void>;
  /** The `LedgerHooks` handler: an entry of a dedicated account evaluates its goal. */
  ledgerHook: LedgerChangeHandler;
  /** Runs after the hourly rates job: the exchange rate may make a milestone cross. */
  afterRates(): Promise<void>;
}

interface Money {
  amount: Decimal;
  currencyCode: string;
}

/** What the goal holds now: the balance of its dedicated account and its earmarks. */
interface Holdings {
  dedicated: Money | null;
  earmarks: Money[];
}

const ONE = new Decimal(1);

async function holdingsOf(tx: Repositories, goal: GoalRow): Promise<Holdings | null> {
  let dedicated: Money | null = null;
  if (goal.dedicatedAccountId !== null) {
    const account = await tx.accounts.get(goal.dedicatedAccountId);
    if (account === null) return null;
    const balances = await tx.ledger.balances([account.id]);
    dedicated = {
      amount: balances.get(account.id) ?? account.initialBalance,
      currencyCode: account.currencyCode,
    };
  }
  const earmarks: Money[] = [];
  for (const row of await tx.goalAllocations.earmarkedByGoal(goal.id)) {
    if (row.accountId === goal.dedicatedAccountId || !row.amount.greaterThan(0)) continue;
    const account = await tx.accounts.get(row.accountId);
    if (account === null) return null;
    earmarks.push({ amount: row.amount, currencyCode: account.currencyCode });
  }
  return { dedicated, earmarks };
}

/** Current Bs per unit of each currency (RN-05); `null` when one of them has no rate. */
async function bobPerUnitOf(
  tx: Repositories,
  rates: GoalRatesReader,
  ctx: RatesContext,
  codes: Iterable<string>,
): Promise<Record<string, Decimal> | null> {
  const today = todayFor(ctx.timezone, ctx.now);
  const result: Record<string, Decimal> = { BOB: ONE };
  for (const code of codes) {
    if (code in result) continue;
    try {
      result[code] = (await rates.ratesForMovement(tx, ctx, code, today)).rateCurBob;
    } catch (error) {
      if (error instanceof AppError && error.code === 'RATE_REQUIRED') return null;
      throw error;
    }
  }
  return result;
}

const toMoney = (money: Money) => ({
  amount: toMoneyString(money.amount),
  currencyCode: money.currencyCode,
});

/** The progress of the goal in its currency; `null` when a rate is missing. */
async function progressOf(
  tx: Repositories,
  rates: GoalRatesReader,
  ctx: RatesContext,
  goal: GoalRow,
  holdings: Holdings,
): Promise<{ progress: Decimal; bobPerUnit: Record<string, Decimal> } | null> {
  const codes = [goal.currencyCode, ...holdings.earmarks.map((money) => money.currencyCode)];
  if (holdings.dedicated !== null) codes.push(holdings.dedicated.currencyCode);
  const bobPerUnit = await bobPerUnitOf(tx, rates, ctx, codes);
  if (bobPerUnit === null) return null;
  const progress = goalProgress(
    holdings.dedicated === null ? null : toMoney(holdings.dedicated),
    holdings.earmarks.map(toMoney),
    { goalCurrency: goal.currencyCode, bobPerUnit },
  );
  return { progress: new Decimal(progress), bobPerUnit };
}

const goalRoute = (goal: GoalRow) => `/metas/${goal.id}`;

async function emitMilestones(
  tx: Repositories,
  notifications: NotificationEmitter,
  rates: GoalRatesReader,
  ctx: RatesContext,
  goal: GoalRow,
): Promise<void> {
  if (goal.archivedAt !== null || !goal.target.greaterThan(0)) return;
  const holdings = await holdingsOf(tx, goal);
  if (holdings === null) return;
  const result = await progressOf(tx, rates, ctx, goal, holdings);
  if (result === null) return;
  for (const milestone of GOAL_MILESTONES) {
    if (result.progress.lessThan(goal.target.times(milestone).div(100))) break;
    // The key is unique per goal and milestone: the rate or the currency never repeat it (RF-M15-04).
    await notifications.emit(tx, ctx.userId, {
      type: 'goal_progress',
      eventKey: `goal:${goal.id}:milestone:${milestone}`,
      params: { goalId: goal.id, name: goal.name, milestone },
      targetRoute: goalRoute(goal),
    });
  }
}

export function createGoalMilestones({
  uow,
  rates,
  notifications,
  timezones,
  users,
  clock,
}: GoalMilestonesDeps): GoalMilestones {
  const evaluate = async (tx: Repositories, ctx: RatesContext, goalId: string) => {
    if (!(await tx.notificationPreferences.isEnabled(ctx.userId, 'goal_progress'))) return;
    const goal = await tx.goals.get(goalId);
    if (goal === null) return;
    await emitMilestones(tx, notifications, rates, ctx, goal);
  };

  return {
    evaluate,

    async ledgerHook(tx, userId, change) {
      const goals: GoalRow[] = [];
      for (const accountId of new Set(change.accountIds)) {
        const goal = await tx.goals.findByDedicatedAccount(accountId);
        if (goal !== null) goals.push(goal);
      }
      if (goals.length === 0) return;
      if (!(await tx.notificationPreferences.isEnabled(userId, 'goal_progress'))) return;
      const ctx: RatesContext = {
        userId,
        timezone: (await timezones.timezoneOf(userId)) ?? BOLIVIA_TIME_ZONE,
        now: clock.now(),
        traceId: uuidv7(),
      };
      for (const goal of goals) {
        await emitMilestones(tx, notifications, rates, ctx, goal);
      }
    },

    async afterRates() {
      let failure: Error | null = null;
      for (const user of await users.withGoalNotices()) {
        const ctx: RatesContext = {
          userId: user.id,
          timezone: user.timezone,
          now: clock.now(),
          traceId: uuidv7(),
        };
        try {
          await uow.run(
            async (tx) => {
              for (const goal of await tx.goals.list()) {
                await emitMilestones(tx, notifications, rates, ctx, goal);
              }
            },
            { userLock: user.id },
          );
        } catch (error) {
          // One user's failure does not stop the others; the next run completes it (RNF-13).
          failure ??= error instanceof Error ? error : new Error(String(error));
        }
      }
      if (failure !== null) throw failure;
    },
  };
}

/** `YYYY-MM` of the month before the one of `date`. */
function previousMonth(date: LocalDate): string {
  const year = Number(date.slice(0, 4));
  const month = Number(date.slice(5, 7));
  return month === 1
    ? `${String(year - 1)}-12`
    : `${String(year)}-${String(month - 1).padStart(2, '0')}`;
}

/** The amount the user was suggested to put aside each month, if the goal has one (RF-M12-06). */
function suggestedAmount(goal: GoalRow, progress: Decimal, today: LocalDate): Decimal | null {
  const suggestion = suggestedMonthly(
    toMoneyString(goal.target),
    toMoneyString(progress),
    goal.targetDate ?? undefined,
    today,
  );
  if (suggestion.kind !== 'monthly' && suggestion.kind !== 'this_month') return null;
  return suggestion.amount === undefined ? null : new Decimal(suggestion.amount);
}

/**
 * The monthly notice of RF-M15-02, inside the caller's transaction: on day 1, for each goal whose
 * contribution of last month was below the suggested one. The contribution is the earmarks plus the
 * entries to the dedicated account minus the withdrawals, each converted at the current rate, so
 * the exchange rate has no effect on it. One notice per goal and month (RNF-12).
 */
export async function emitMonthlyGoalNotices(
  tx: Repositories,
  notifications: NotificationEmitter,
  rates: GoalRatesReader,
  ctx: RatesContext,
  today: LocalDate,
): Promise<void> {
  if (!today.endsWith('-01')) return;
  if (!(await tx.notificationPreferences.isEnabled(ctx.userId, 'goal_progress'))) return;
  const month = previousMonth(today);
  for (const goal of await tx.goals.list()) {
    const holdings = await holdingsOf(tx, goal);
    if (holdings === null) continue;
    const current = await progressOf(tx, rates, ctx, goal, holdings);
    if (current === null) continue;
    const suggested = suggestedAmount(goal, current.progress, today);
    if (suggested === null) continue;

    const items: Money[] = [];
    for (const item of await tx.goalAllocations.history(goal.id)) {
      const isEvent = item.ledgerKind === null;
      if (isEvent && item.accountId === goal.dedicatedAccountId) continue;
      const day = isEvent ? todayFor(ctx.timezone, item.createdAt) : item.date;
      if (!day.startsWith(`${month}-`)) continue;
      const account = await tx.accounts.get(item.accountId);
      if (account === null) continue;
      items.push({ amount: item.amount, currencyCode: account.currencyCode });
    }
    const bobPerUnit = await bobPerUnitOf(tx, rates, ctx, [
      ...Object.keys(current.bobPerUnit),
      ...items.map((item) => item.currencyCode),
    ]);
    if (bobPerUnit === null) continue;
    const goalRate = bobPerUnit[goal.currencyCode] ?? ONE;
    const contributed = items.reduce((sum, item) => {
      const amount =
        item.currencyCode === goal.currencyCode
          ? item.amount
          : item.amount.times(bobPerUnit[item.currencyCode] ?? ONE).div(goalRate);
      return sum.plus(amount);
    }, new Decimal(0));
    if (!contributed.lessThan(suggested)) continue;

    await notifications.emit(tx, ctx.userId, {
      type: 'goal_progress',
      eventKey: `goal:${goal.id}:monthly:${month}`,
      params: {
        goalId: goal.id,
        name: goal.name,
        month,
        contributed: contributed.toDecimalPlaces(2, Decimal.ROUND_HALF_UP).toFixed(2),
        suggested: toMoneyString(suggested),
        currencyCode: goal.currencyCode,
      },
      targetRoute: goalRoute(goal),
    });
  }
}
