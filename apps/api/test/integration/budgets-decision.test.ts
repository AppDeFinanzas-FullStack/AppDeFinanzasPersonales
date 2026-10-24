import { DecisionInput } from '@finanzas/contracts';
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
  type TestBudget,
  type TestBudgetStatus,
} from '../factories/budget.factory.js';
import { createCategory } from '../factories/category.factory.js';
import { createGoal, deleteGoalsOf } from '../factories/goal.factory.js';
import { deleteLedgerOf } from '../factories/ledger.factory.js';
import { createUser, deleteCreatedUsers } from '../factories/user.factory.js';
import { disconnectTestPrisma, testPrisma } from './setup/db.js';

/**
 * Assumptions (plan §4.11.2 fixes `POST /api/budgets/:id/periods/:periodId/decision` and
 * `DecisionInput`, not the service signature; same shape as the rest of the budgets service):
 * - `createBudgetsService({ uow, rates, notifications, ids })` also gives
 *   `decide(ctx, budgetId, periodId, input)`, where `input` is the output of `DecisionInput.parse`.
 * - Errors are `AppError`s; a budget of another user is `NOT_FOUND`.
 * - The closed period, its next period and its `period_close:{periodId}` notice come from the
 *   `budgets.close` job of TASK-200 (`createBudgetsJobs({ uow, clock, notifications, ids })`).
 * - An earmark is a `goal_allocation_event` with `origin = 'budget'`; a real transfer to the
 *   dedicated account is a `ledger_transaction` with `origin = 'goal_transfer'`.
 */
interface BudgetsServiceUnderTest {
  decide(ctx: RatesContext, budgetId: string, periodId: string, input: DecisionInput): Promise<unknown>;
}
type CreateBudgetsService = (deps: {
  uow: UnitOfWork;
  rates: ReturnType<typeof createRatesService>;
  notifications: ReturnType<typeof createNotificationEmitter>;
  ids: { next: () => string };
}) => BudgetsServiceUnderTest;

interface BudgetsJobsUnderTest {
  close(): Promise<void>;
  closeForUser(userId: string): Promise<void>;
}
type CreateBudgetsJobs = (deps: {
  uow: UnitOfWork;
  clock: Clock;
  notifications: ReturnType<typeof createNotificationEmitter>;
  ids: { next: () => string };
}) => BudgetsJobsUnderTest;

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
const budgets = createBudgetsService({
  uow,
  rates: createRatesService({ uow }),
  notifications,
  ids,
});

const TZ = 'America/La_Paz';
const OCTOBER = { startDate: '2090-10-01', endDate: '2090-10-31' };
/** The close runs on 2090-11-02 in La Paz: October closes and November opens. */
const CLOSE_AT = new Date('2090-11-02T15:00:00Z');
/** The user decides the next day. */
const DECIDE_AT = new Date('2090-11-03T15:00:00Z');
const usedUserIds: string[] = [];

afterAll(async () => {
  await deleteBudgetsOf(usedUserIds);
  await deleteGoalsOf(usedUserIds);
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

async function rejectionOf(promise: Promise<unknown>): Promise<AppError> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(AppError);
    return error as AppError;
  }
  throw new Error('The promise was expected to reject');
}

interface Closed {
  userId: string;
  /** "Banco": where the earmarks go, with 1000.00 BOB. */
  bankId: string;
  /** "Efectivo": where the spending comes from. */
  cashId: string;
  categoryId: string;
  budget: TestBudget;
  periodId: string;
}

/**
 * A budget of `amount` BOB whose October closed with `spent` spent: the close job leaves October
 * `closed_pending` with its notice and, unless the budget was finalizing, November open.
 */
async function closedBudget(options: {
  amount: string;
  spent: string;
  userId?: string;
  categoryId?: string | null;
  status?: TestBudgetStatus;
}): Promise<Closed> {
  let userId = options.userId;
  if (userId === undefined) {
    const user = await createUser({ timezone: TZ });
    usedUserIds.push(user.id);
    userId = user.id;
  }
  const bank = await createAccount(userId, { initialBalance: '1000.00' });
  const cash = await createAccount(userId, { type: 'cash', initialBalance: '5000.00' });
  const categoryId =
    options.categoryId === undefined ? (await createCategory(userId)).id : options.categoryId;
  const budget = await createBudget(userId, {
    categoryId,
    amount: options.amount,
    status: options.status ?? 'active',
  });
  const october = await createBudgetPeriod(userId, budget, OCTOBER);
  if (options.spent !== '0.00') {
    const spendCategory = categoryId ?? (await createCategory(userId)).id;
    await createSpend(userId, {
      accountId: cash.id,
      categoryId: spendCategory,
      date: '2090-10-15',
      amount: options.spent,
    });
  }
  await jobs.closeForUser(userId);
  return {
    userId,
    bankId: bank.id,
    cashId: cash.id,
    categoryId: categoryId ?? '',
    budget,
    periodId: october.id,
  };
}

interface PeriodRow {
  id: string;
  start: string;
  amount: string;
  carryoverIn: string;
  status: string;
  spentAtDecision: string | null;
  resultAtDecision: string | null;
}

async function periodsOf(budgetId: string): Promise<PeriodRow[]> {
  return prisma.$queryRaw<PeriodRow[]>`
    SELECT id::text AS id, to_char(start_date, 'YYYY-MM-DD') AS start, amount::text AS amount,
           carryover_in::text AS "carryoverIn", status::text AS status,
           spent_at_decision::text AS "spentAtDecision",
           result_at_decision::text AS "resultAtDecision"
      FROM budget_period WHERE budget_id = ${budgetId}::uuid ORDER BY start_date`;
}

async function periodOf(budgetId: string, start: string): Promise<PeriodRow | undefined> {
  return (await periodsOf(budgetId)).find((row) => row.start === start);
}

/** Available of a period: amount + carryover_in + non-voided late adjustments (RF-M11-05). */
async function availableOf(periodId: string): Promise<string> {
  const rows = await prisma.$queryRaw<{ available: string }[]>`
    SELECT (p.amount + p.carryover_in + COALESCE((
              SELECT SUM(a.amount) FROM budget_late_adjustment a
               WHERE a.period_id = p.id AND a.voided_at IS NULL), 0))::text AS available
      FROM budget_period p WHERE p.id = ${periodId}::uuid`;
  return rows[0]?.available ?? '';
}

interface EarmarkRow {
  goalId: string;
  accountId: string;
  amount: string;
  origin: string;
}

async function earmarksOf(userId: string): Promise<EarmarkRow[]> {
  return prisma.$queryRaw<EarmarkRow[]>`
    SELECT goal_id::text AS "goalId", account_id::text AS "accountId", amount::text AS amount,
           origin::text AS origin
      FROM goal_allocation_event WHERE user_id = ${userId}::uuid ORDER BY created_at`;
}

async function goalTransfersOf(
  userId: string,
): Promise<{ accountId: string; amount: string }[]> {
  return prisma.$queryRaw<{ accountId: string; amount: string }[]>`
    SELECT e.account_id::text AS "accountId", e.amount::text AS amount
      FROM ledger_transaction t JOIN ledger_entry e ON e.transaction_id = t.id
     WHERE t.user_id = ${userId}::uuid AND t.origin = 'goal_transfer' AND t.deleted_at IS NULL
     ORDER BY e.amount`;
}

async function decisionStatusOf(userId: string, periodId: string): Promise<string | null> {
  const rows = await prisma.$queryRaw<{ status: string | null }[]>`
    SELECT decision_status::text AS status FROM notification
     WHERE user_id = ${userId}::uuid AND event_key = ${`period_close:${periodId}`}`;
  return rows[0]?.status ?? null;
}

const surplus = (
  carry: string,
  discard: string,
  toGoal?: { goalId: string; accountId: string; amount: string; mode?: 'earmark' | 'transfer' },
): DecisionInput =>
  DecisionInput.parse({
    result: 'surplus',
    carry,
    discard,
    ...(toGoal === undefined ? {} : { toGoal: { mode: 'earmark', ...toGoal } }),
  });

const deficit = (mode: 'carry' | 'absorb'): DecisionInput =>
  DecisionInput.parse({ result: 'deficit', mode });

describe('budgets.decide — sobrante', () => {
  it('RF-M11-08 Repartir un sobrante: arrastrar 50 y enviar 100 a "Viaje" desde el Banco deja noviembre con 850 y un apartado de 100', async () => {
    const s = await closedBudget({ amount: '800.00', spent: '650.00' });
    const viaje = await createGoal(s.userId, { name: 'Viaje' });

    await budgets.decide(
      ctxFor(s.userId),
      s.budget.id,
      s.periodId,
      surplus('50.00', '0.00', { goalId: viaje.id, accountId: s.bankId, amount: '100.00' }),
    );

    const november = await periodOf(s.budget.id, '2090-11-01');
    expect(november).toBeDefined();
    expect(await availableOf(november?.id ?? '')).toBe('850.00');
    expect(await earmarksOf(s.userId)).toEqual([
      { goalId: viaje.id, accountId: s.bankId, amount: '100.00', origin: 'budget' },
    ]);
  });

  it('RF-M11-08 guarda spent_at_decision y result_at_decision y el período queda decidido', async () => {
    const s = await closedBudget({ amount: '800.00', spent: '650.00' });

    await budgets.decide(ctxFor(s.userId), s.budget.id, s.periodId, surplus('0.00', '150.00'));

    const october = await periodOf(s.budget.id, '2090-10-01');
    expect(october).toMatchObject({
      status: 'decided',
      spentAtDecision: '650.00',
      resultAtDecision: '150.00',
    });
  });

  it('RF-M11-08 el arrastre reemplaza el carryover_in del período siguiente, no se suma', async () => {
    const s = await closedBudget({ amount: '800.00', spent: '650.00' });
    await prisma.$executeRaw`
      UPDATE budget_period SET carryover_in = 30
       WHERE budget_id = ${s.budget.id}::uuid AND start_date = '2090-11-01'::date`;

    await budgets.decide(ctxFor(s.userId), s.budget.id, s.periodId, surplus('50.00', '100.00'));

    expect((await periodOf(s.budget.id, '2090-11-01'))?.carryoverIn).toBe('50.00');
  });

  it('RF-M11-08 un reparto que no suma exacto el sobrante da SPLIT_MISMATCH y no decide', async () => {
    const s = await closedBudget({ amount: '800.00', spent: '650.00' });

    const error = await rejectionOf(
      budgets.decide(ctxFor(s.userId), s.budget.id, s.periodId, surplus('50.00', '50.00')),
    );

    expect(error.code).toBe('SPLIT_MISMATCH');
    expect((await periodOf(s.budget.id, '2090-10-01'))?.status).toBe('closed_pending');
    expect((await periodOf(s.budget.id, '2090-11-01'))?.carryoverIn).toBe('0.00');
  });

  it('TASK-201 decidir resuelve el aviso period_close del período', async () => {
    const s = await closedBudget({ amount: '800.00', spent: '650.00' });
    expect(await decisionStatusOf(s.userId, s.periodId)).toBe('waiting');

    await budgets.decide(ctxFor(s.userId), s.budget.id, s.periodId, surplus('0.00', '150.00'));

    expect(await decisionStatusOf(s.userId, s.periodId)).toBe('resolved');
  });
});

describe('budgets.decide — exceso', () => {
  it('RF-M11-08 Exceso arrastrado: 300 con 400 gastados deja el período siguiente con 200 disponible', async () => {
    const s = await closedBudget({ amount: '300.00', spent: '400.00' });

    await budgets.decide(ctxFor(s.userId), s.budget.id, s.periodId, deficit('carry'));

    const next = await periodOf(s.budget.id, '2090-11-01');
    expect(next?.carryoverIn).toBe('-100.00');
    expect(await availableOf(next?.id ?? '')).toBe('200.00');
    expect(await periodOf(s.budget.id, '2090-10-01')).toMatchObject({
      status: 'decided',
      spentAtDecision: '400.00',
      resultAtDecision: '-100.00',
    });
  });

  it('RF-M11-08 absorber un exceso deja el período siguiente sin arrastre', async () => {
    const s = await closedBudget({ amount: '300.00', spent: '400.00' });

    await budgets.decide(ctxFor(s.userId), s.budget.id, s.periodId, deficit('absorb'));

    const next = await periodOf(s.budget.id, '2090-11-01');
    expect(next?.carryoverIn).toBe('0.00');
    expect(await availableOf(next?.id ?? '')).toBe('300.00');
    expect((await periodOf(s.budget.id, '2090-10-01'))?.status).toBe('decided');
  });
});

describe('budgets.decide — enviar a meta', () => {
  it('EC-M11-02 enviar más que el saldo libre de la cuenta da EARMARK_EXCEEDS_FREE y no decide', async () => {
    const s = await closedBudget({ amount: '800.00', spent: '650.00' });
    const goal = await createGoal(s.userId);
    const poor = await createAccount(s.userId, { initialBalance: '60.00' });

    const error = await rejectionOf(
      budgets.decide(
        ctxFor(s.userId),
        s.budget.id,
        s.periodId,
        surplus('0.00', '50.00', { goalId: goal.id, accountId: poor.id, amount: '100.00' }),
      ),
    );

    expect(error.code).toBe('EARMARK_EXCEEDS_FREE');
    expect(await earmarksOf(s.userId)).toEqual([]);
    expect((await periodOf(s.budget.id, '2090-10-01'))?.status).toBe('closed_pending');
  });

  it('EC-M11-03 con la meta archivada da GOAL_NOT_AVAILABLE', async () => {
    const s = await closedBudget({ amount: '800.00', spent: '650.00' });
    const goal = await createGoal(s.userId);
    await prisma.$executeRaw`UPDATE goal SET archived_at = now() WHERE id = ${goal.id}::uuid`;

    const error = await rejectionOf(
      budgets.decide(
        ctxFor(s.userId),
        s.budget.id,
        s.periodId,
        surplus('0.00', '50.00', { goalId: goal.id, accountId: s.bankId, amount: '100.00' }),
      ),
    );

    expect(error.code).toBe('GOAL_NOT_AVAILABLE');
    expect(await earmarksOf(s.userId)).toEqual([]);
    expect((await periodOf(s.budget.id, '2090-10-01'))?.status).toBe('closed_pending');
  });

  it('EC-M11-03 con la meta eliminada da GOAL_NOT_AVAILABLE', async () => {
    const s = await closedBudget({ amount: '800.00', spent: '650.00' });
    const goal = await createGoal(s.userId);
    await prisma.$executeRaw`DELETE FROM goal WHERE id = ${goal.id}::uuid`;

    const error = await rejectionOf(
      budgets.decide(
        ctxFor(s.userId),
        s.budget.id,
        s.periodId,
        surplus('0.00', '50.00', { goalId: goal.id, accountId: s.bankId, amount: '100.00' }),
      ),
    );

    expect(error.code).toBe('GOAL_NOT_AVAILABLE');
    expect((await periodOf(s.budget.id, '2090-10-01'))?.status).toBe('closed_pending');
  });

  it('RF-M11-09 enviar a meta desde una subcategoría da TO_GOAL_NOT_ALLOWED', async () => {
    const user = await createUser({ timezone: TZ });
    usedUserIds.push(user.id);
    const parent = await createCategory(user.id);
    const child = await createCategory(user.id, { parentId: parent.id });
    const s = await closedBudget({
      amount: '800.00',
      spent: '650.00',
      userId: user.id,
      categoryId: child.id,
    });
    const goal = await createGoal(s.userId);

    const error = await rejectionOf(
      budgets.decide(
        ctxFor(s.userId),
        s.budget.id,
        s.periodId,
        surplus('0.00', '50.00', { goalId: goal.id, accountId: s.bankId, amount: '100.00' }),
      ),
    );

    expect(error.code).toBe('TO_GOAL_NOT_ALLOWED');
    expect(await earmarksOf(s.userId)).toEqual([]);
  });

  it('RF-M11-09 si existe un presupuesto general, enviar a meta desde una categoría principal da TO_GOAL_NOT_ALLOWED', async () => {
    const user = await createUser({ timezone: TZ });
    usedUserIds.push(user.id);
    await createBudget(user.id, { categoryId: null, amount: '5000.00' });
    const s = await closedBudget({ amount: '800.00', spent: '650.00', userId: user.id });
    const goal = await createGoal(s.userId);

    const error = await rejectionOf(
      budgets.decide(
        ctxFor(s.userId),
        s.budget.id,
        s.periodId,
        surplus('0.00', '50.00', { goalId: goal.id, accountId: s.bankId, amount: '100.00' }),
      ),
    );

    expect(error.code).toBe('TO_GOAL_NOT_ALLOWED');
  });

  it('RF-M11-09 el presupuesto general sí puede enviar a meta', async () => {
    const s = await closedBudget({ amount: '800.00', spent: '650.00', categoryId: null });
    const goal = await createGoal(s.userId);

    await budgets.decide(
      ctxFor(s.userId),
      s.budget.id,
      s.periodId,
      surplus('0.00', '50.00', { goalId: goal.id, accountId: s.bankId, amount: '100.00' }),
    );

    expect(await earmarksOf(s.userId)).toEqual([
      { goalId: goal.id, accountId: s.bankId, amount: '100.00', origin: 'budget' },
    ]);
  });

  it('RF-M11-09 con cuenta dedicada, la alternativa es una transferencia real hacia ella', async () => {
    const s = await closedBudget({ amount: '800.00', spent: '650.00' });
    const dedicated = await createAccount(s.userId, { type: 'savings' });
    const goal = await createGoal(s.userId, { dedicatedAccountId: dedicated.id });

    await budgets.decide(
      ctxFor(s.userId),
      s.budget.id,
      s.periodId,
      surplus('0.00', '50.00', {
        goalId: goal.id,
        accountId: s.bankId,
        amount: '100.00',
        mode: 'transfer',
      }),
    );

    expect(await goalTransfersOf(s.userId)).toEqual([
      { accountId: s.bankId, amount: '-100.00' },
      { accountId: dedicated.id, amount: '100.00' },
    ]);
    expect(await earmarksOf(s.userId)).toEqual([]);
  });
});

describe('budgets.decide — presupuesto finalizado', () => {
  it('EC-M11-09 arrastrar un sobrante en un presupuesto finalizado se rechaza', async () => {
    const s = await closedBudget({ amount: '800.00', spent: '650.00', status: 'finalizing' });
    expect(await periodsOf(s.budget.id)).toHaveLength(1);

    await rejectionOf(
      budgets.decide(ctxFor(s.userId), s.budget.id, s.periodId, surplus('50.00', '100.00')),
    );

    expect((await periodOf(s.budget.id, '2090-10-01'))?.status).toBe('closed_pending');
  });

  it('EC-M11-09 arrastrar un exceso en un presupuesto finalizado se rechaza', async () => {
    const s = await closedBudget({ amount: '300.00', spent: '400.00', status: 'finalizing' });

    await rejectionOf(budgets.decide(ctxFor(s.userId), s.budget.id, s.periodId, deficit('carry')));

    expect((await periodOf(s.budget.id, '2090-10-01'))?.status).toBe('closed_pending');
  });

  it('EC-M11-09 en un presupuesto finalizado se puede descartar o absorber', async () => {
    const s = await closedBudget({ amount: '800.00', spent: '650.00', status: 'finalizing' });
    const o = await closedBudget({ amount: '300.00', spent: '400.00', status: 'finalizing' });

    await budgets.decide(ctxFor(s.userId), s.budget.id, s.periodId, surplus('0.00', '150.00'));
    await budgets.decide(ctxFor(o.userId), o.budget.id, o.periodId, deficit('absorb'));

    expect((await periodOf(s.budget.id, '2090-10-01'))?.status).toBe('decided');
    expect((await periodOf(o.budget.id, '2090-10-01'))?.status).toBe('decided');
  });
});

describe('budgets.decide — idempotencia y aislamiento', () => {
  it('RNF-11 una segunda decisión da DECISION_ALREADY_MADE y no aplica nada más', async () => {
    const s = await closedBudget({ amount: '800.00', spent: '650.00' });
    const goal = await createGoal(s.userId);
    const input = surplus('50.00', '0.00', {
      goalId: goal.id,
      accountId: s.bankId,
      amount: '100.00',
    });

    await budgets.decide(ctxFor(s.userId), s.budget.id, s.periodId, input);
    const error = await rejectionOf(
      budgets.decide(ctxFor(s.userId), s.budget.id, s.periodId, surplus('0.00', '150.00')),
    );

    expect(error.code).toBe('DECISION_ALREADY_MADE');
    expect(await earmarksOf(s.userId)).toHaveLength(1);
    expect((await periodOf(s.budget.id, '2090-11-01'))?.carryoverIn).toBe('50.00');
  });

  it('RNF-11 dos decisiones a la vez aplican una sola', async () => {
    const s = await closedBudget({ amount: '800.00', spent: '650.00' });
    const goal = await createGoal(s.userId);
    const input = surplus('50.00', '0.00', {
      goalId: goal.id,
      accountId: s.bankId,
      amount: '100.00',
    });

    const results = await Promise.allSettled([
      budgets.decide(ctxFor(s.userId), s.budget.id, s.periodId, input),
      budgets.decide(ctxFor(s.userId), s.budget.id, s.periodId, input),
    ]);

    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const rejected = results.filter((r) => r.status === 'rejected');
    expect(rejected).toHaveLength(1);
    const reason: unknown = rejected[0]?.status === 'rejected' ? rejected[0].reason : undefined;
    expect(reason).toBeInstanceOf(AppError);
    expect((reason as AppError).code).toBe('DECISION_ALREADY_MADE');
    expect(await earmarksOf(s.userId)).toHaveLength(1);
    expect((await periodOf(s.budget.id, '2090-11-01'))?.carryoverIn).toBe('50.00');
  });

  it('TASK-201 no se puede decidir el período de un presupuesto de otro usuario', async () => {
    const s = await closedBudget({ amount: '800.00', spent: '650.00' });
    const intruder = await createUser({ timezone: TZ });
    usedUserIds.push(intruder.id);

    const error = await rejectionOf(
      budgets.decide(ctxFor(intruder.id), s.budget.id, s.periodId, surplus('0.00', '150.00')),
    );

    expect(error.code).toBe('NOT_FOUND');
    expect((await periodOf(s.budget.id, '2090-10-01'))?.status).toBe('closed_pending');
  });
});
