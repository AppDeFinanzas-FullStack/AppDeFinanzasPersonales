import { nextPeriod, thresholdsCrossed, toMoneyString } from '@finanzas/domain';
import { Decimal } from 'decimal.js';

import type { Clock } from '../ports/clock.js';
import type { IdGenerator } from '../ports/id-generator.js';
import type { BudgetPeriodRow, BudgetRow, Repositories } from '../ports/repositories.js';
import type { UnitOfWork } from '../ports/unit-of-work.js';
import type { NotificationEmitter } from '../shared/notification-emitter.js';

const DAY_MS = 24 * 60 * 60_000;
/** The decision of a closed period waits 7 days from the moment it is generated (RF-M11-10). */
const DECISION_WINDOW_MS = 7 * DAY_MS;

export interface BudgetsJobsDeps {
  uow: UnitOfWork;
  clock: Clock;
  notifications: Pick<NotificationEmitter, 'emit'>;
  ids: IdGenerator;
}

export interface BudgetsJobs {
  /** The `budgets.close` handler of the tick: closes the ended periods of every user. */
  close(): Promise<void>;
  /** The per-user scope of `budgets.close`, for the catch-up of the user (ADR-01). */
  closeForUser(userId: string): Promise<void>;
}

/**
 * The `budgets.close` job (plan §4.11.3): every `open` period that ended before the today of its
 * user (RNF-20) moves to `closed_pending` with a 7-day deadline counted from now (RF-M11-10), the
 * next period starts with `carryover_in = 0` and `next_start_day` applied, and the close notice
 * waits for its decision. A `finalizing` budget gets no next period and becomes `finalized`
 * (EC-M11-09). Each user runs under its lock and the `open` guard, so it is idempotent (RNF-13).
 */
export function createBudgetsJobs({ uow, clock, notifications, ids }: BudgetsJobsDeps): BudgetsJobs {
  /** Notifies only the highest threshold the new period starts above (RF-M11-13). */
  async function alertStart(
    repos: Repositories,
    userId: string,
    budget: BudgetRow,
    categoryName: string | null,
    period: Pick<BudgetPeriodRow, 'id' | 'startDate' | 'endDate' | 'amount'>,
  ): Promise<void> {
    if (budget.thresholds.length === 0) {
      return;
    }
    const spent = await repos.budgetPeriods.spent(budget, period);
    const crossed = thresholdsCrossed(
      toMoneyString(spent),
      toMoneyString(period.amount),
      budget.thresholds,
      [],
      true,
    );
    for (const threshold of crossed) {
      if (await repos.budgetPeriods.recordThresholdHit(period.id, threshold)) {
        await notifications.emit(repos, userId, {
          type: 'budget_alert',
          eventKey: `budget_alert:${period.id}:${threshold}`,
          params: { budgetId: budget.id, categoryName, threshold },
          targetRoute: `/presupuestos/${budget.id}`,
        });
      }
    }
  }

  async function closePeriod(
    repos: Repositories,
    userId: string,
    period: BudgetPeriodRow,
    now: Date,
  ): Promise<void> {
    if (!(await repos.budgetPeriods.close(period.id, new Date(now.getTime() + DECISION_WINDOW_MS)))) {
      return;
    }
    const budget = await repos.budgets.get(period.budgetId);
    if (budget === null) {
      return;
    }
    const category = budget.categoryId === null ? null : await repos.categories.get(budget.categoryId);
    const categoryName = category?.name ?? null;
    await notifications.emit(repos, userId, {
      type: 'period_close',
      eventKey: `period_close:${period.id}`,
      params: { budgetId: budget.id, periodId: period.id, categoryName },
      targetRoute: `/presupuestos/${budget.id}`,
      decision: { kind: 'budget_period', ref: period.id },
    });

    if (budget.status === 'finalizing') {
      await repos.budgets.update(budget.id, { status: 'finalized' });
      return;
    }
    if (budget.status !== 'active') {
      return;
    }

    const startDay = budget.nextStartDay ?? budget.startDay;
    const range = nextPeriod({ start: period.startDate, end: period.endDate }, startDay);
    if (budget.nextStartDay !== null) {
      await repos.budgets.update(budget.id, { startDay, nextStartDay: null });
    }
    const next = {
      id: ids.next(),
      budgetId: budget.id,
      startDate: range.start,
      endDate: range.end,
      amount: budget.amount,
      carryoverIn: new Decimal(0),
    };
    await repos.budgetPeriods.insert(next);
    await alertStart(repos, userId, budget, categoryName, next);
  }

  async function closeForUser(userId: string): Promise<void> {
    await uow.run(
      async (repos) => {
        const now = clock.now();
        // A next period may have ended too after a long outage; it closes in the same run.
        for (;;) {
          const ended = await repos.budgetPeriods.listEnded(now);
          if (ended.length === 0) {
            return;
          }
          for (const period of ended) {
            await closePeriod(repos, userId, period, now);
          }
        }
      },
      { userLock: userId },
    );
  }

  return {
    async close() {
      const owners = await uow.run((repos) => repos.budgets.ownersWithEndedPeriods(clock.now()), {
        readOnly: true,
      });
      for (const userId of owners) {
        await closeForUser(userId);
      }
    },
    closeForUser,
  };
}
