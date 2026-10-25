import { thresholdsCrossed, toMoneyString } from '@finanzas/domain';
import { Decimal } from 'decimal.js';

import type { IdGenerator } from '../ports/id-generator.js';
import type { BudgetRow, ClosedBudgetPeriod, Repositories } from '../ports/repositories.js';
import type { LedgerChange, LedgerChangeHandler } from './ledger-hooks.js';
import type { NotificationEmitter } from './notification-emitter.js';

export interface BudgetLedgerHookDeps {
  notifications: NotificationEmitter;
  ids: IdGenerator;
}

/** Statuses whose budgets do not react to ledger changes (RF-M11-11, RF-M11-13). */
const INERT = new Set<BudgetRow['status']>(['paused', 'finalized']);

/**
 * `true` when the applied decision included carrying: a surplus with something carried, or a
 * deficit carried to the next period (plan §4.11.3).
 */
export function includedCarry(decision: unknown): boolean {
  if (typeof decision !== 'object' || decision === null) {
    return false;
  }
  const { result, carry, mode } = decision as Record<string, unknown>;
  if (result === 'surplus') {
    return typeof carry === 'string' && new Decimal(carry).greaterThan(0);
  }
  return result === 'deficit' && mode === 'carry';
}

/**
 * The `LedgerHooks` handler of budgets (plan §4.11.3): notifies the thresholds crossed in the
 * period in course once each (RF-M11-13, RNF-12) and moves to its carryover the difference of the
 * late movements of a period decided with carry (RF-M11-11, EC-M11-05).
 */
export function createBudgetLedgerHook({
  notifications,
  ids,
}: BudgetLedgerHookDeps): LedgerChangeHandler {
  async function alertThresholds(tx: Repositories, userId: string, budget: BudgetRow) {
    if (budget.status !== 'active' || budget.thresholds.length === 0) {
      return;
    }
    const period = await tx.budgetPeriods.current(budget.id);
    if (period === null) {
      return;
    }
    const spent = await tx.budgetPeriods.spent(budget, period);
    const crossed = thresholdsCrossed(
      toMoneyString(spent),
      toMoneyString(period.amount),
      budget.thresholds,
      [],
      false,
    );
    if (crossed.length === 0) {
      return;
    }
    const category =
      budget.categoryId === null ? null : await tx.categories.get(budget.categoryId);
    for (const threshold of crossed) {
      if (await tx.budgetPeriods.recordThresholdHit(period.id, threshold)) {
        await notifications.emit(tx, userId, {
          type: 'budget_alert',
          eventKey: `budget_alert:${period.id}:${threshold}`,
          params: { budgetId: budget.id, categoryName: category?.name ?? null, threshold },
          targetRoute: `/presupuestos/${budget.id}`,
        });
      }
    }
  }

  async function adjustLate(tx: Repositories, budget: BudgetRow, change: LedgerChange) {
    const closed = await tx.budgetPeriods.closedContaining(budget.id, change.dates);
    const carried = closed.filter(
      (period): period is ClosedBudgetPeriod & { spentAtDecision: Decimal } =>
        period.spentAtDecision !== null && includedCarry(period.decision),
    );
    if (carried.length === 0) {
      return;
    }
    const current = await tx.budgetPeriods.current(budget.id);
    if (current === null) {
      return;
    }
    for (const period of carried) {
      const spent = await tx.budgetPeriods.spent(budget, period);
      const amount = period.spentAtDecision.minus(spent).minus(period.adjusted);
      if (amount.isZero()) {
        continue;
      }
      await tx.budgetPeriods.insertLateAdjustment({
        id: ids.next(),
        periodId: current.id,
        sourcePeriodId: period.id,
        amount,
      });
    }
  }

  return async (tx, userId, change) => {
    const budgets = await tx.budgets.listAffected(change.categoryIds);
    for (const budget of budgets) {
      if (INERT.has(budget.status)) {
        continue;
      }
      await adjustLate(tx, budget, change);
      await alertThresholds(tx, userId, budget);
    }
  };
}
