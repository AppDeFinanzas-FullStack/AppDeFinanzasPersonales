import type { BudgetDto, CreateBudgetInput, UpdateBudgetInput } from '@finanzas/contracts';
import {
  available as availableOf,
  pace as paceOf,
  periodFor,
  periodLabel,
  result as resultOf,
  thresholdsCrossed,
  todayFor,
  todayShouldBe,
  toMoneyString,
} from '@finanzas/domain';
import type { BudgetPeriod, LocalDate } from '@finanzas/domain';
import { Decimal } from 'decimal.js';

import { AppError } from '../errors.js';
import type {
  BudgetPeriodRow,
  BudgetPeriodStatus,
  BudgetRow,
  CategoryRow,
  Repositories,
} from '../ports/repositories.js';
import type { UnitOfWork } from '../ports/unit-of-work.js';
import { assertLimit } from '../shared/limits.js';
import type { NotificationEmitter } from '../shared/notification-emitter.js';
import type { RatesContext, RatesService } from './rates.service.js';

export type BudgetsContext = RatesContext;

/**
 * Regular period that contains `date`; with a pending `nextStartDay` it stretches
 * until the day before the first new start day after its regular end (RF-M11-07).
 */
function periodFrom(startDay: number, nextStartDay: number | null, date: LocalDate): BudgetPeriod {
  const regular = periodFor(startDay, null, date);
  if (nextStartDay === null) return regular;
  return { start: regular.start, end: periodFor(nextStartDay, null, regular.end).end };
}

/** A past or current period of a budget, as the detail shows it (plan §4.11.4). */
export interface BudgetPeriodSummary {
  id: string;
  start: string;
  end: string;
  amount: string;
  carryoverIn: string;
  status: BudgetPeriodStatus;
}

export type BudgetDetail = BudgetDto & { periods: BudgetPeriodSummary[] };

export interface BudgetsService {
  /**
   * Creates a budget, idempotent by `input.id` (ADR-11), with its period in course; only the
   * highest threshold already crossed is notified (RF-M11-13).
   */
  create(ctx: BudgetsContext, input: CreateBudgetInput): Promise<{ created: boolean; budget: BudgetDto }>;
  /** The budgets of the user with their period in course (plan §4.11.2). */
  list(ctx: BudgetsContext): Promise<BudgetDto[]>;
  /** One budget with its 12 last periods (plan §4.11.2). */
  get(ctx: BudgetsContext, id: string): Promise<BudgetDetail>;
  /**
   * Amount, default action and thresholds apply to the period in course (RF-M11-06); `startDay`
   * is kept as `nextStartDay` and stretches the period in course (RF-M11-07).
   */
  update(ctx: BudgetsContext, id: string, input: UpdateBudgetInput): Promise<BudgetDto>;
  /** Freezes the carryover in force and drops the period in course (plan §4.11.3). */
  pause(ctx: BudgetsContext, id: string): Promise<void>;
  /** Opens the period that contains today with the frozen carryover (EC-M11-08). */
  resume(ctx: BudgetsContext, id: string): Promise<void>;
  /** Carryover of the period in course to 0 and its late adjustments voided (RF-M11-12). */
  resetCarryover(ctx: BudgetsContext, id: string): Promise<void>;
  /** Deletes the budget with its history and resolves its decision notices (plan §4.11.2). */
  remove(ctx: BudgetsContext, id: string): Promise<void>;
}

export interface BudgetsServiceDeps {
  uow: UnitOfWork;
  rates: Pick<RatesService, 'currentRateFor'>;
  notifications: NotificationEmitter;
  ids: { next: () => string };
}

/** How many past periods the detail shows (plan §4.11.4). */
const HISTORY_SIZE = 12;

/** Upper bound to read every period of a budget. */
const ALL_PERIODS = 10_000;

const LIVE_STATUSES: readonly BudgetRow['status'][] = ['active', 'paused'];

interface PeriodView {
  period: BudgetPeriodRow | { id: string; startDate: string; endDate: string; amount: Decimal; carryoverIn: Decimal };
  spent: Decimal;
  lateAdjustments: { sourceLabel: string; amount: Decimal }[];
}

/** What is stored for one budget at the moment of reading it. */
interface BudgetSnapshot {
  budget: BudgetRow;
  category: CategoryRow | null;
  current: PeriodView | null;
  pendingClose: (PeriodView & { deadline: Date | null }) | null;
  periods: BudgetPeriodRow[];
}

/** The budgets that could be nested under another one (RF-M11-02). */
interface Family {
  budget: BudgetRow;
  /** The category id of the parent budget, or `general` for a root category. */
  parentKey: string | null;
}

async function periodView(
  repos: Repositories,
  budget: BudgetRow,
  period: PeriodView['period'],
): Promise<PeriodView> {
  const spent = await repos.budgetPeriods.spent(budget, period);
  const lateAdjustments: PeriodView['lateAdjustments'] = [];
  for (const adjustment of await repos.budgetPeriods.lateAdjustments(period.id)) {
    if (adjustment.voidedAt !== null) continue;
    const source = await repos.budgetPeriods.get(adjustment.sourcePeriodId);
    lateAdjustments.push({
      sourceLabel:
        source === null ? '' : periodLabel({ start: source.startDate, end: source.endDate }),
      amount: adjustment.amount,
    });
  }
  return { period, spent, lateAdjustments };
}

async function snapshotOf(
  repos: Repositories,
  budget: BudgetRow,
  withHistory: boolean,
): Promise<BudgetSnapshot> {
  const category = budget.categoryId === null ? null : await repos.categories.get(budget.categoryId);
  const recent = await repos.budgetPeriods.listByBudget(budget.id, HISTORY_SIZE);
  const open = recent.find((period) => period.status === 'open');
  const current = open === undefined ? null : await periodView(repos, budget, open);
  const pending = await repos.budgets.pendingClose(budget.id);
  const pendingClose =
    pending === null
      ? null
      : { ...(await periodView(repos, budget, pending)), deadline: pending.deadline };
  return { budget, category, current, pendingClose, periods: withHistory ? recent : [] };
}

async function familyOf(repos: Repositories): Promise<Family[]> {
  const family: Family[] = [];
  for (const budget of await repos.budgets.list()) {
    if (!LIVE_STATUSES.includes(budget.status)) continue;
    if (budget.categoryId === null) {
      family.push({ budget, parentKey: null });
      continue;
    }
    const category = await repos.categories.get(budget.categoryId);
    family.push({ budget, parentKey: category?.parentId ?? 'general' });
  }
  return family;
}

function available(view: PeriodView): string {
  return availableOf(
    toMoneyString(view.period.amount),
    toMoneyString(view.period.carryoverIn),
    view.lateAdjustments.map((adjustment) => toMoneyString(adjustment.amount)),
  );
}

async function requireBudget(repos: Repositories, id: string): Promise<BudgetRow> {
  const budget = await repos.budgets.get(id);
  if (budget === null) {
    throw new AppError('NOT_FOUND');
  }
  return budget;
}

async function openPeriodOf(repos: Repositories, budgetId: string): Promise<BudgetPeriodRow | null> {
  const periods = await repos.budgetPeriods.listByBudget(budgetId, HISTORY_SIZE);
  return periods.find((period) => period.status === 'open') ?? null;
}

async function requireActiveCurrency(repos: Repositories, code: string): Promise<void> {
  const currency = await repos.currencies.lockForShare(code);
  if (currency === null) {
    throw new AppError('VALIDATION_ERROR', { issues: [{ path: 'currencyCode', code: 'not_found' }] });
  }
  if (currency.status !== 'active') {
    throw new AppError('CURRENCY_INACTIVE');
  }
}

/** An expense category that is active and is not "Deudas y préstamos" (RF-M11-01). */
async function requireBudgetable(repos: Repositories, categoryId: string): Promise<CategoryRow> {
  const category = await repos.categories.get(categoryId);
  if (category === null) {
    throw new AppError('CATEGORY_NOT_FOUND');
  }
  if (
    category.kind !== 'expense' ||
    category.status !== 'active' ||
    (await repos.budgets.categorySystemKey(categoryId)) === 'debts'
  ) {
    throw new AppError('CATEGORY_NOT_BUDGETABLE');
  }
  return category;
}

export function createBudgetsService({
  uow,
  rates,
  notifications,
  ids,
}: BudgetsServiceDeps): BudgetsService {
  /** Budget DTOs from the snapshots; rates are read after the transaction (RN-05). */
  const toDtos = async (
    ctx: BudgetsContext,
    snapshots: BudgetSnapshot[],
    family: Family[],
  ): Promise<BudgetDto[]> => {
    const bobPerUnit = new Map<string, Decimal | null>();
    const rateOf = async (code: string): Promise<Decimal | null> => {
      if (!bobPerUnit.has(code)) {
        bobPerUnit.set(code, await rates.currentRateFor(ctx, code));
      }
      return bobPerUnit.get(code) ?? null;
    };

    /** Whether the budgets nested in this one add up to more than it (RF-M11-02). */
    const childrenExceedParent = async (budget: BudgetRow): Promise<boolean> => {
      const key = budget.categoryId ?? 'general';
      const children = family.filter(
        (member) => member.parentKey === key && member.budget.id !== budget.id,
      );
      if (children.length === 0) return false;
      const parentRate = await rateOf(budget.currencyCode);
      let total = new Decimal(0);
      for (const { budget: child } of children) {
        if (child.currencyCode === budget.currencyCode) {
          total = total.plus(child.amount);
          continue;
        }
        const childRate = await rateOf(child.currencyCode);
        if (childRate === null || parentRate === null || parentRate.isZero()) continue;
        total = total.plus(child.amount.times(childRate).div(parentRate));
      }
      return total.greaterThan(budget.amount);
    };

    const today = todayFor(ctx.timezone, ctx.now);
    const dtos: BudgetDto[] = [];
    for (const { budget, category, current, pendingClose } of snapshots) {
      const dto: BudgetDto = {
        id: budget.id,
        scope: budget.scope,
        amount: toMoneyString(budget.amount),
        currencyCode: budget.currencyCode,
        startDay: budget.startDay,
        defaultAction: budget.defaultAction,
        thresholds: budget.thresholds,
        status: budget.status,
        childrenExceedParent: await childrenExceedParent(budget),
      };
      if (category !== null) {
        dto.category = {
          id: category.id,
          name: category.name,
          icon: category.icon as NonNullable<BudgetDto['category']>['icon'],
          color: category.color as NonNullable<BudgetDto['category']>['color'],
        };
      }
      if (budget.nextStartDay !== null) dto.nextStartDay = budget.nextStartDay;
      if (current !== null) {
        const range = { start: current.period.startDate, end: current.period.endDate };
        const free = available(current);
        const spent = toMoneyString(current.spent);
        dto.current = {
          periodId: current.period.id,
          start: range.start,
          end: range.end,
          spent,
          available: free,
          carryover: toMoneyString(current.period.carryoverIn),
          lateAdjustments: current.lateAdjustments.map((adjustment) => ({
            sourceLabel: adjustment.sourceLabel,
            amount: toMoneyString(adjustment.amount),
          })),
          todayShouldBe: todayShouldBe(free, range, today),
          pace: paceOf(free, spent, range, today),
        };
      }
      if (pendingClose !== null && pendingClose.deadline !== null) {
        const range = { start: pendingClose.period.startDate, end: pendingClose.period.endDate };
        dto.pendingClose = {
          periodId: pendingClose.period.id,
          label: periodLabel(range),
          result: resultOf(available(pendingClose), toMoneyString(pendingClose.spent)),
          deadline: todayFor(ctx.timezone, pendingClose.deadline),
        };
      }
      dtos.push(dto);
    }
    return dtos;
  };

  const single = async (
    ctx: BudgetsContext,
    snapshot: BudgetSnapshot,
    family: Family[],
  ): Promise<BudgetDto> => {
    const [dto] = await toDtos(ctx, [snapshot], family);
    if (dto === undefined) {
      throw new AppError('INTERNAL_ERROR');
    }
    return dto;
  };

  return {
    async create(ctx, input) {
      const { created, snapshot, family } = await uow.run(
        async (repos) => {
          const existing = await repos.budgets.get(input.id);
          if (existing !== null) {
            return {
              created: false,
              snapshot: await snapshotOf(repos, existing, false),
              family: await familyOf(repos),
            };
          }

          const categoryId = input.scope === 'category' ? (input.categoryId ?? null) : null;
          if (input.scope === 'category' && categoryId === null) {
            throw new AppError('VALIDATION_ERROR', {
              issues: [{ path: 'categoryId', code: 'required' }],
            });
          }
          assertLimit(await repos.budgets.count(), 'budgets');
          const category = categoryId === null ? null : await requireBudgetable(repos, categoryId);
          const live = await repos.budgets.findLive(categoryId);
          if (live !== null) {
            throw new AppError('BUDGET_EXISTS', { budgetId: live });
          }
          await requireActiveCurrency(repos, input.currencyCode);

          const amount = new Decimal(input.amount);
          await repos.budgets.insert({
            id: input.id,
            scope: input.scope,
            categoryId,
            amount,
            currencyCode: input.currencyCode,
            startDay: input.startDay,
            defaultAction: input.defaultAction,
            thresholds: input.thresholds,
          });
          const budget = await repos.budgets.get(input.id);
          if (budget === null) {
            throw new AppError('INTERNAL_ERROR');
          }

          const range = periodFor(budget.startDay, null, todayFor(ctx.timezone, ctx.now));
          const periodId = ids.next();
          await repos.budgetPeriods.insert({
            id: periodId,
            budgetId: budget.id,
            startDate: range.start,
            endDate: range.end,
            amount,
            carryoverIn: new Decimal(0),
          });

          // A budget created already above its thresholds notifies only the highest (RF-M11-13).
          const spent = await repos.budgetPeriods.spent(budget, {
            startDate: range.start,
            endDate: range.end,
          });
          const crossed = thresholdsCrossed(
            toMoneyString(spent),
            toMoneyString(amount),
            budget.thresholds,
            [],
            true,
          );
          for (const threshold of crossed) {
            if (await repos.budgetPeriods.recordThresholdHit(periodId, threshold)) {
              await notifications.emit(repos, ctx.userId, {
                type: 'budget_alert',
                eventKey: `budget_alert:${periodId}:${threshold}`,
                params: {
                  budgetId: budget.id,
                  categoryName: category?.name ?? null,
                  threshold,
                },
                targetRoute: `/presupuestos/${budget.id}`,
              });
            }
          }

          return {
            created: true,
            snapshot: await snapshotOf(repos, budget, false),
            family: await familyOf(repos),
          };
        },
        { userLock: ctx.userId },
      );
      return { created, budget: await single(ctx, snapshot, family) };
    },

    async list(ctx) {
      const { snapshots, family } = await uow.run(
        async (repos) => {
          const result: BudgetSnapshot[] = [];
          for (const budget of await repos.budgets.list()) {
            result.push(await snapshotOf(repos, budget, false));
          }
          return { snapshots: result, family: await familyOf(repos) };
        },
        { userLock: ctx.userId, readOnly: true },
      );
      return toDtos(ctx, snapshots, family);
    },

    async get(ctx, id) {
      const { snapshot, family } = await uow.run(
        async (repos) => {
          const budget = await repos.budgets.get(id);
          if (budget === null) {
            throw new AppError('NOT_FOUND');
          }
          return { snapshot: await snapshotOf(repos, budget, true), family: await familyOf(repos) };
        },
        { userLock: ctx.userId, readOnly: true },
      );
      return {
        ...(await single(ctx, snapshot, family)),
        periods: snapshot.periods.map((period) => ({
          id: period.id,
          start: period.startDate,
          end: period.endDate,
          amount: toMoneyString(period.amount),
          carryoverIn: toMoneyString(period.carryoverIn),
          status: period.status,
        })),
      };
    },

    async update(ctx, id, input) {
      const { snapshot, family } = await uow.run(
        async (repos) => {
          const budget = await requireBudget(repos, id);
          const amount = input.amount === undefined ? undefined : new Decimal(input.amount);
          const nextStartDay =
            input.startDay === undefined
              ? undefined
              : input.startDay === budget.startDay
                ? null
                : input.startDay;
          await repos.budgets.update(id, {
            ...(amount === undefined ? {} : { amount }),
            ...(input.defaultAction === undefined ? {} : { defaultAction: input.defaultAction }),
            ...(input.thresholds === undefined ? {} : { thresholds: input.thresholds }),
            ...(nextStartDay === undefined ? {} : { nextStartDay }),
          });

          const open = await openPeriodOf(repos, id);
          if (open !== null) {
            const endDate =
              nextStartDay === undefined
                ? undefined
                : periodFrom(budget.startDay, nextStartDay, open.startDate).end;
            await repos.budgetPeriods.update(open.id, {
              ...(amount === undefined ? {} : { amount }),
              ...(endDate === undefined ? {} : { endDate }),
            });
          }

          return {
            snapshot: await snapshotOf(repos, await requireBudget(repos, id), false),
            family: await familyOf(repos),
          };
        },
        { userLock: ctx.userId },
      );
      return single(ctx, snapshot, family);
    },

    async pause(ctx, id) {
      await uow.run(
        async (repos) => {
          const budget = await requireBudget(repos, id);
          if (budget.status !== 'active') {
            throw new AppError('INVALID_STATE');
          }
          const open = await openPeriodOf(repos, id);
          await repos.budgets.update(id, {
            status: 'paused',
            frozenCarryover: open?.carryoverIn ?? new Decimal(0),
          });
          if (open !== null) {
            await repos.budgetPeriods.delete(open.id);
          }
        },
        { userLock: ctx.userId },
      );
    },

    async resume(ctx, id) {
      await uow.run(
        async (repos) => {
          const budget = await requireBudget(repos, id);
          if (budget.status !== 'paused') {
            throw new AppError('INVALID_STATE');
          }
          const range = periodFrom(
            budget.startDay,
            budget.nextStartDay,
            todayFor(ctx.timezone, ctx.now),
          );
          await repos.budgetPeriods.insert({
            id: ids.next(),
            budgetId: id,
            startDate: range.start,
            endDate: range.end,
            amount: budget.amount,
            carryoverIn: budget.frozenCarryover ?? new Decimal(0),
          });
          await repos.budgets.update(id, { status: 'active', frozenCarryover: null });
        },
        { userLock: ctx.userId },
      );
    },

    async resetCarryover(ctx, id) {
      await uow.run(
        async (repos) => {
          await requireBudget(repos, id);
          const open = await openPeriodOf(repos, id);
          if (open === null) {
            throw new AppError('INVALID_STATE');
          }
          await repos.budgetPeriods.update(open.id, { carryoverIn: new Decimal(0) });
          await repos.budgetPeriods.voidLateAdjustments(open.id);
        },
        { userLock: ctx.userId },
      );
    },

    async remove(ctx, id) {
      await uow.run(
        async (repos) => {
          await requireBudget(repos, id);
          for (const period of await repos.budgetPeriods.listByBudget(id, ALL_PERIODS)) {
            await notifications.resolveDecision(repos, ctx.userId, 'budget_period', period.id);
          }
          await repos.budgets.delete(id);
        },
        { userLock: ctx.userId },
      );
    },
  };
}
