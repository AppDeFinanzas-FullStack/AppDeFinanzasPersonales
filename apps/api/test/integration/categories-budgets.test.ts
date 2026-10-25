import { DecisionInput, type MergePreviewDto } from '@finanzas/contracts';
import { uuidv7 } from 'uuidv7';
import { afterAll, describe, expect, it } from 'vitest';

import { AppError } from '../../src/application/errors.js';
import type { Clock } from '../../src/application/ports/clock.js';
import type { UnitOfWork } from '../../src/application/ports/unit-of-work.js';
import {
  createRatesService,
  type RatesContext,
} from '../../src/application/services/rates.service.js';
import { createNotificationEmitter } from '../../src/application/shared/notification-emitter.js';
import { createAccountRepository } from '../../src/infrastructure/persistence/repositories/account.repository.js';
import { createBudgetPeriodRepository } from '../../src/infrastructure/persistence/repositories/budget-period.repository.js';
import { createBudgetRepository } from '../../src/infrastructure/persistence/repositories/budget.repository.js';
import { createCategoryRepository } from '../../src/infrastructure/persistence/repositories/category.repository.js';
import { createCurrencyRepository } from '../../src/infrastructure/persistence/repositories/currency.repository.js';
import { createGoalAllocationRepository } from '../../src/infrastructure/persistence/repositories/goal-allocation.repository.js';
import { createGoalRepository } from '../../src/infrastructure/persistence/repositories/goal.repository.js';
import { createLedgerRepository } from '../../src/infrastructure/persistence/repositories/ledger.repository.js';
import { createMarketRateRepository } from '../../src/infrastructure/persistence/repositories/market-rate.repository.js';
import { createNotificationPreferenceRepository } from '../../src/infrastructure/persistence/repositories/notification-preference.repository.js';
import { createNotificationRepository } from '../../src/infrastructure/persistence/repositories/notification.repository.js';
import { createUndoActionRepository } from '../../src/infrastructure/persistence/repositories/undo-action.repository.js';
import { createUserFxEventRepository } from '../../src/infrastructure/persistence/repositories/user-fx-event.repository.js';
import { createUserSettingsRepository } from '../../src/infrastructure/persistence/repositories/user-settings.repository.js';
import { createUnitOfWork } from '../../src/infrastructure/persistence/unit-of-work.js';
import { createAccount } from '../factories/account.factory.js';
import {
  createBudget,
  createBudgetPeriod,
  createSpend,
  deleteBudgetsOf,
  type TestBudgetStatus,
} from '../factories/budget.factory.js';
import { createCategory, deleteCategoryUsageOf } from '../factories/category.factory.js';
import { deleteLedgerOf } from '../factories/ledger.factory.js';
import { createUser, deleteCreatedUsers } from '../factories/user.factory.js';
import { disconnectTestPrisma, testPrisma } from './setup/db.js';

/**
 * Assumptions (plan §4.5.2 fixes the endpoints, their errors and `MergePreviewDto`; plan §4.11.3
 * fixes the `finalizing → finalized` transition; the signatures follow the existing services):
 * - `createCategoriesService({ uow })` gives `archive(userId, id)`, `update(userId, id, patch)`,
 *   `mergePreview(userId, { fromId, toId })` and `merge(userId, { fromId, toId })`.
 * - The warning of a merge where both categories had a budget is `budgetEffect: 'kept_target'` of
 *   the preview; a budget that moves to B is `'moved'`.
 * - The close of a finalizing budget comes from the `budgets.close` job of TASK-200 and the
 *   decision from `decide` of TASK-201.
 * - Errors are `AppError`s with the code of the catalogue (ADR-09).
 */
interface CategoriesServiceUnderTest {
  archive(userId: string, id: string): Promise<unknown>;
  update(userId: string, id: string, input: { parentId?: string | null }): Promise<unknown>;
  mergePreview(userId: string, input: { fromId: string; toId: string }): Promise<MergePreviewDto>;
  merge(userId: string, input: { fromId: string; toId: string }): Promise<unknown>;
}
type CreateCategoriesService = (deps: { uow: UnitOfWork }) => CategoriesServiceUnderTest;

interface BudgetsServiceUnderTest {
  decide(
    ctx: RatesContext,
    budgetId: string,
    periodId: string,
    input: DecisionInput,
  ): Promise<unknown>;
}
type CreateBudgetsService = (deps: {
  uow: UnitOfWork;
  rates: ReturnType<typeof createRatesService>;
  notifications: ReturnType<typeof createNotificationEmitter>;
  ids: { next: () => string };
}) => BudgetsServiceUnderTest;

interface BudgetsJobsUnderTest {
  closeForUser(userId: string): Promise<void>;
}
type CreateBudgetsJobs = (deps: {
  uow: UnitOfWork;
  clock: Clock;
  notifications: ReturnType<typeof createNotificationEmitter>;
  ids: { next: () => string };
}) => BudgetsJobsUnderTest;

const { createCategoriesService } =
  (await import('../../src/application/services/categories.service.js')) as unknown as {
    createCategoriesService: CreateCategoriesService;
  };
const { createBudgetsService } =
  (await import('../../src/application/services/budgets.service.js')) as unknown as {
    createBudgetsService: CreateBudgetsService;
  };
const { createBudgetsJobs } = (await import('../../src/application/jobs/budgets.js')) as unknown as {
  createBudgetsJobs: CreateBudgetsJobs;
};

const NIL_USER = '00000000-0000-0000-0000-000000000000';
const prisma = testPrisma();

const uow: UnitOfWork = createUnitOfWork(prisma, (tx, userId) => ({
  marketRates: createMarketRateRepository(tx),
  currencies: createCurrencyRepository(tx, userId ?? NIL_USER),
  userFxEvents: createUserFxEventRepository(tx, userId ?? NIL_USER),
  userSettings: createUserSettingsRepository(tx),
  accounts: createAccountRepository(tx, userId ?? NIL_USER),
  ledger: createLedgerRepository(tx, userId ?? NIL_USER),
  undoActions: createUndoActionRepository(tx, userId ?? NIL_USER),
  categories: createCategoryRepository(tx, userId ?? NIL_USER),
  notifications: createNotificationRepository(tx),
  notificationPreferences: createNotificationPreferenceRepository(tx),
  goals: createGoalRepository(tx, userId ?? NIL_USER),
  goalAllocations: createGoalAllocationRepository(tx, userId ?? NIL_USER),
  budgets: createBudgetRepository(tx, userId ?? NIL_USER),
  budgetPeriods: createBudgetPeriodRepository(tx, userId ?? NIL_USER),
}));

const notifications = createNotificationEmitter({ release: '1.1' });
const ids = { next: () => uuidv7() };
const categories = createCategoriesService({ uow });
const budgets = createBudgetsService({
  uow,
  rates: createRatesService({ uow }),
  notifications,
  ids,
});

const TZ = 'America/La_Paz';
const OCTOBER = { startDate: '2090-10-01', endDate: '2090-10-31' };
/** The close runs on 2090-11-02 in La Paz: October closes. */
const CLOSE_AT = new Date('2090-11-02T15:00:00Z');
/** The user decides the next day, within the 7 days. */
const DECIDE_AT = new Date('2090-11-03T15:00:00Z');
const usedUserIds: string[] = [];

afterAll(async () => {
  await deleteBudgetsOf(usedUserIds);
  await deleteCategoryUsageOf(usedUserIds);
  await deleteLedgerOf(usedUserIds);
  await deleteCreatedUsers();
  await disconnectTestPrisma();
});

const dateIn = (timezone: string, instant: Date): string =>
  new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(instant);

const closeClock: Clock = {
  now: () => new Date(CLOSE_AT.getTime()),
  todayFor: (timezone) => dateIn(timezone, CLOSE_AT),
};
const jobs = createBudgetsJobs({ uow, clock: closeClock, notifications, ids });

const ctxFor = (userId: string): RatesContext => ({
  userId,
  timezone: TZ,
  now: DECIDE_AT,
  traceId: uuidv7(),
});

async function newUserId(): Promise<string> {
  const user = await createUser({ timezone: TZ });
  usedUserIds.push(user.id);
  return user.id;
}

async function rejectionOf(promise: Promise<unknown>): Promise<AppError> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(AppError);
    return error as AppError;
  }
  throw new Error('The promise was expected to reject');
}

interface BudgetRow {
  id: string;
  categoryId: string | null;
  status: string;
}

async function budgetsOf(userId: string): Promise<BudgetRow[]> {
  return prisma.$queryRaw<BudgetRow[]>`
    SELECT id::text AS id, category_id::text AS "categoryId", status::text AS status
      FROM budget WHERE user_id = ${userId}::uuid ORDER BY id`;
}

async function budgetStatusOf(budgetId: string): Promise<string | undefined> {
  const rows = await prisma.$queryRaw<{ status: string }[]>`
    SELECT status::text AS status FROM budget WHERE id = ${budgetId}::uuid`;
  return rows[0]?.status;
}

interface PeriodRow {
  id: string;
  start: string;
  end: string;
  amount: string;
  carryoverIn: string;
  status: string;
  decisionDeadline: Date | null;
  spentAtDecision: string | null;
  resultAtDecision: string | null;
}

async function periodsOf(budgetId: string): Promise<PeriodRow[]> {
  return prisma.$queryRaw<PeriodRow[]>`
    SELECT id::text AS id, to_char(start_date, 'YYYY-MM-DD') AS start,
           to_char(end_date, 'YYYY-MM-DD') AS "end", amount::text AS amount,
           carryover_in::text AS "carryoverIn", status::text AS status,
           decision_deadline AS "decisionDeadline",
           spent_at_decision::text AS "spentAtDecision",
           result_at_decision::text AS "resultAtDecision"
      FROM budget_period WHERE budget_id = ${budgetId}::uuid ORDER BY start_date`;
}

async function lateAdjustmentsOf(budgetId: string): Promise<number> {
  const rows = await prisma.$queryRaw<{ count: number }[]>`
    SELECT count(*)::int AS count FROM budget_late_adjustment a
      JOIN budget_period p ON p.id = a.period_id
     WHERE p.budget_id = ${budgetId}::uuid`;
  return rows[0]?.count ?? 0;
}

async function categoryExists(userId: string, id: string): Promise<boolean> {
  const rows = await prisma.$queryRaw<{ id: string }[]>`
    SELECT id::text AS id FROM category WHERE user_id = ${userId}::uuid AND id = ${id}::uuid`;
  return rows.length > 0;
}

async function decisionNoticeOf(
  userId: string,
  periodId: string,
): Promise<{ decisionStatus: string | null } | undefined> {
  const rows = await prisma.$queryRaw<{ decisionStatus: string | null }[]>`
    SELECT decision_status::text AS "decisionStatus" FROM notification
     WHERE user_id = ${userId}::uuid AND event_key = ${`period_close:${periodId}`}`;
  return rows[0];
}

/** A budget of 500.00 BOB over a new category, with October 2090 open. */
async function budgetWithOctober(
  userId: string,
  status: TestBudgetStatus = 'active',
): Promise<{ categoryId: string; budgetId: string; octoberId: string }> {
  const category = await createCategory(userId);
  const budget = await createBudget(userId, { categoryId: category.id, status });
  const october = await createBudgetPeriod(userId, budget, OCTOBER);
  return { categoryId: category.id, budgetId: budget.id, octoberId: october.id };
}

// ---------- archive ----------

describe('archivar una categoría con presupuesto', () => {
  it('RF-M5-07 Archivar una categoría con presupuesto y recurrente: el presupuesto sigue hasta el fin del período y pasa a Finalizado', async () => {
    const userId = await newUserId();
    const ocio = await budgetWithOctober(userId);

    await categories.archive(userId, ocio.categoryId);

    expect(await budgetStatusOf(ocio.budgetId)).toBe('finalizing');
    const during = await periodsOf(ocio.budgetId);
    expect(during.map((p) => ({ id: p.id, status: p.status }))).toEqual([
      { id: ocio.octoberId, status: 'open' },
    ]);

    await jobs.closeForUser(userId);

    expect(await budgetStatusOf(ocio.budgetId)).toBe('finalized');
    const after = await periodsOf(ocio.budgetId);
    expect(after.map((p) => ({ start: p.start, status: p.status }))).toEqual([
      { start: '2090-10-01', status: 'closed_pending' },
    ]);
  });

  it('RF-M5-07 un presupuesto pausado de la categoría archivada también pasa a finalizing', async () => {
    const userId = await newUserId();
    const category = await createCategory(userId);
    const budget = await createBudget(userId, { categoryId: category.id, status: 'paused' });

    await categories.archive(userId, category.id);

    expect(await budgetStatusOf(budget.id)).toBe('finalizing');
  });

  it('RF-M5-07 archivar una categoría no toca el presupuesto de otra categoría', async () => {
    const userId = await newUserId();
    const archived = await budgetWithOctober(userId);
    const other = await budgetWithOctober(userId);

    await categories.archive(userId, archived.categoryId);

    expect(await budgetStatusOf(other.budgetId)).toBe('active');
  });

  it('EC-M11-04 la decisión de cierre pendiente sigue disponible después de archivar', async () => {
    const userId = await newUserId();
    const cash = await createAccount(userId, { type: 'cash', initialBalance: '5000.00' });
    const ocio = await budgetWithOctober(userId);
    await createSpend(userId, {
      accountId: cash.id,
      categoryId: ocio.categoryId,
      date: '2090-10-15',
      amount: '300.00',
    });
    await jobs.closeForUser(userId);
    const before = (await periodsOf(ocio.budgetId)).find((p) => p.id === ocio.octoberId);
    const noticeBefore = await decisionNoticeOf(userId, ocio.octoberId);
    expect(before?.status).toBe('closed_pending');

    await categories.archive(userId, ocio.categoryId);

    const after = (await periodsOf(ocio.budgetId)).find((p) => p.id === ocio.octoberId);
    expect(after?.status).toBe('closed_pending');
    expect(after?.decisionDeadline?.getTime()).toBe(before?.decisionDeadline?.getTime());
    expect(await decisionNoticeOf(userId, ocio.octoberId)).toEqual(noticeBefore);

    await budgets.decide(
      ctxFor(userId),
      ocio.budgetId,
      ocio.octoberId,
      DecisionInput.parse({ result: 'surplus', carry: '0.00', discard: '200.00' }),
    );

    const decided = (await periodsOf(ocio.budgetId)).find((p) => p.id === ocio.octoberId);
    expect(decided).toMatchObject({
      status: 'decided',
      spentAtDecision: '300.00',
      resultAtDecision: '200.00',
    });
  });
});

// ---------- merge ----------

describe('fusionar categorías con presupuesto', () => {
  it('RF-M5-08 el presupuesto de A pasa a B si B no tenía', async () => {
    const userId = await newUserId();
    const a = await budgetWithOctober(userId);
    const b = await createCategory(userId);
    const input = { fromId: a.categoryId, toId: b.id };

    const preview = await categories.mergePreview(userId, input);
    expect(preview.budgetEffect).toBe('moved');

    await categories.merge(userId, input);

    expect(await categoryExists(userId, a.categoryId)).toBe(false);
    expect(await budgetsOf(userId)).toEqual([
      { id: a.budgetId, categoryId: b.id, status: 'active' },
    ]);
    expect((await periodsOf(a.budgetId)).map((p) => p.id)).toEqual([a.octoberId]);
  });

  it('RF-M5-08 con los dos presupuestos se conserva el de B y se elimina el de A, con aviso', async () => {
    const userId = await newUserId();
    const a = await budgetWithOctober(userId);
    const b = await budgetWithOctober(userId);
    const input = { fromId: a.categoryId, toId: b.categoryId };

    const preview = await categories.mergePreview(userId, input);
    expect(preview.budgetEffect).toBe('kept_target');

    await categories.merge(userId, input);

    expect(await categoryExists(userId, a.categoryId)).toBe(false);
    expect(await budgetsOf(userId)).toEqual([
      { id: b.budgetId, categoryId: b.categoryId, status: 'active' },
    ]);
    expect(await periodsOf(a.budgetId)).toEqual([]);
    expect((await periodsOf(b.budgetId)).map((p) => p.id)).toEqual([b.octoberId]);
  });

  it('RF-M5-08 sin presupuesto en A la previsualización no anuncia efecto sobre presupuestos', async () => {
    const userId = await newUserId();
    const a = await createCategory(userId);
    const b = await budgetWithOctober(userId);

    const preview = await categories.mergePreview(userId, { fromId: a.id, toId: b.categoryId });

    expect(preview.budgetEffect).toBe('none');
  });

  it('RF-M5-08 con un cierre pendiente en A, MERGE_PENDING_CLOSE y nada cambia', async () => {
    const userId = await newUserId();
    const a = await budgetWithOctober(userId);
    const b = await createCategory(userId);
    await jobs.closeForUser(userId);
    const periodsBefore = await periodsOf(a.budgetId);
    expect(periodsBefore.find((p) => p.id === a.octoberId)?.status).toBe('closed_pending');

    const error = await rejectionOf(
      categories.merge(userId, { fromId: a.categoryId, toId: b.id }),
    );

    expect(error.code).toBe('MERGE_PENDING_CLOSE');
    expect(error.status).toBe(409);
    expect(await categoryExists(userId, a.categoryId)).toBe(true);
    expect(await budgetsOf(userId)).toEqual([
      { id: a.budgetId, categoryId: a.categoryId, status: 'active' },
    ]);
    expect(await periodsOf(a.budgetId)).toEqual(periodsBefore);
  });

  it('RF-M5-08 con el cierre de A ya decidido la fusión procede', async () => {
    const userId = await newUserId();
    const category = await createCategory(userId);
    const budget = await createBudget(userId, { categoryId: category.id });
    await createBudgetPeriod(userId, budget, { ...OCTOBER, status: 'decided' });
    const b = await createCategory(userId);

    await categories.merge(userId, { fromId: category.id, toId: b.id });

    expect(await categoryExists(userId, category.id)).toBe(false);
    expect(await budgetsOf(userId)).toEqual([
      { id: budget.id, categoryId: b.id, status: 'active' },
    ]);
  });
});

// ---------- move a subcategory ----------

describe('mover una subcategoría con presupuesto', () => {
  it('EC-M5-03 después de mover una subcategoría, los períodos cerrados del padre no cambian', async () => {
    const userId = await newUserId();
    const cash = await createAccount(userId, { type: 'cash', initialBalance: '5000.00' });
    const oldParent = await createCategory(userId);
    const newParent = await createCategory(userId);
    const child = await createCategory(userId, { parentId: oldParent.id });
    await createBudget(userId, { categoryId: child.id, amount: '100.00' });
    const parentBudget = await createBudget(userId, {
      categoryId: oldParent.id,
      amount: '500.00',
    });
    const closed = await createBudgetPeriod(userId, parentBudget, {
      ...OCTOBER,
      status: 'decided',
    });
    await prisma.$executeRaw`
      UPDATE budget_period SET spent_at_decision = 120.00, result_at_decision = 380.00
       WHERE id = ${closed.id}::uuid`;
    await createBudgetPeriod(userId, parentBudget, {
      startDate: '2090-11-01',
      endDate: '2090-11-30',
    });
    await createSpend(userId, {
      accountId: cash.id,
      categoryId: child.id,
      date: '2090-10-10',
      amount: '120.00',
    });
    const before = await periodsOf(parentBudget.id);

    await categories.update(userId, child.id, { parentId: newParent.id });

    expect(await periodsOf(parentBudget.id)).toEqual(before);
    expect(await lateAdjustmentsOf(parentBudget.id)).toBe(0);
    expect(before.find((p) => p.id === closed.id)).toMatchObject({
      status: 'decided',
      spentAtDecision: '120.00',
      resultAtDecision: '380.00',
    });
  });
});
