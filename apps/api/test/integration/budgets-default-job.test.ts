import { DecisionInput } from '@finanzas/contracts';
import { uuidv7 } from 'uuidv7';
import { afterAll, describe, expect, it } from 'vitest';

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
import { createCategory } from '../factories/category.factory.js';
import { deleteLedgerOf } from '../factories/ledger.factory.js';
import { createUser, deleteCreatedUsers } from '../factories/user.factory.js';
import { disconnectTestPrisma, testPrisma } from './setup/db.js';

/**
 * Assumptions (plan §4.11.3 fixes the job `budgets.defaultDecision`; the factory shape follows
 * `budgets.close` of TASK-200):
 * - `budgets.ts` exports `createBudgetsJobs({ uow, clock, notifications, ids })`, which also gives
 *   `defaultDecision()`: the handler of the tick that, for every user, defaults the
 *   `closed_pending` periods whose `decision_deadline < clock.now()`.
 * - The default action `carry` carries the whole surplus, or the deficit as a negative amount, to
 *   the next period (same as the manual decision); `discard` carries nothing. A finalized budget
 *   has no next period, so nothing is carried.
 * - `budgets.decide` is the service of the manual decision (`DECISION_ALREADY_MADE` if decided).
 */
interface BudgetsServiceUnderTest {
  decide(ctx: RatesContext, budgetId: string, periodId: string, input: DecisionInput): Promise<unknown>;
}
interface BudgetsJobsUnderTest {
  closeForUser(userId: string): Promise<void>;
  defaultDecision(): Promise<void>;
}
type CreateBudgetsJobs = (deps: {
  uow: UnitOfWork;
  clock: Clock;
  notifications: ReturnType<typeof createNotificationEmitter>;
  ids: { next: () => string };
}) => BudgetsJobsUnderTest;

const { createBudgetsService } =
  (await import('../../src/application/services/budgets.service.js')) as unknown as {
    createBudgetsService: (deps: {
      uow: UnitOfWork;
      rates: ReturnType<typeof createRatesService>;
      notifications: ReturnType<typeof createNotificationEmitter>;
      ids: { next: () => string };
    }) => BudgetsServiceUnderTest;
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
const DAY_MS = 24 * 60 * 60_000;
const OCTOBER = { startDate: '2090-10-01', endDate: '2090-10-31' };
const CLOSE_AT = new Date('2090-11-02T15:00:00Z');
const usedUserIds: string[] = [];

afterAll(async () => {
  await deleteBudgetsOf(usedUserIds);
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

const clockAt = (instant: Date): Clock => ({
  now: () => new Date(instant.getTime()),
  todayFor: (timezone) => dateIn(timezone, instant),
});

const jobsAt = (instant: Date): BudgetsJobsUnderTest =>
  createBudgetsJobs({ uow, clock: clockAt(instant), notifications, ids });

/** Seven days after the close, plus an hour: the deadline has passed. */
const AFTER_DEADLINE = new Date(CLOSE_AT.getTime() + 7 * DAY_MS + 60 * 60_000);

interface Closed {
  userId: string;
  budgetId: string;
  periodId: string;
}

/** A budget whose October closed (job `budgets.close`) with `spent` spent and `action` as default. */
async function closedBudget(options: {
  amount: string;
  spent: string;
  action: 'discard' | 'carry';
  status?: TestBudgetStatus;
}): Promise<Closed> {
  const user = await createUser({ timezone: TZ });
  usedUserIds.push(user.id);
  const cash = await createAccount(user.id, { type: 'cash', initialBalance: '5000.00' });
  const category = await createCategory(user.id);
  const budget = await createBudget(user.id, {
    categoryId: category.id,
    amount: options.amount,
    status: options.status ?? 'active',
  });
  await prisma.$executeRaw`
    UPDATE budget SET default_action = ${options.action}::budget_default_action
     WHERE id = ${budget.id}::uuid`;
  const october = await createBudgetPeriod(user.id, budget, OCTOBER);
  await createSpend(user.id, {
    accountId: cash.id,
    categoryId: category.id,
    date: '2090-10-15',
    amount: options.spent,
  });
  await jobsAt(CLOSE_AT).closeForUser(user.id);
  return { userId: user.id, budgetId: budget.id, periodId: october.id };
}

interface PeriodRow {
  id: string;
  start: string;
  carryoverIn: string;
  status: string;
  resultAtDecision: string | null;
}

async function periodsOf(budgetId: string): Promise<PeriodRow[]> {
  return prisma.$queryRaw<PeriodRow[]>`
    SELECT id::text AS id, to_char(start_date, 'YYYY-MM-DD') AS start,
           carryover_in::text AS "carryoverIn", status::text AS status,
           result_at_decision::text AS "resultAtDecision"
      FROM budget_period WHERE budget_id = ${budgetId}::uuid ORDER BY start_date`;
}

async function decisionStatusOf(userId: string, periodId: string): Promise<string | null> {
  const rows = await prisma.$queryRaw<{ status: string | null }[]>`
    SELECT decision_status::text AS status FROM notification
     WHERE user_id = ${userId}::uuid AND event_key = ${`period_close:${periodId}`}`;
  return rows[0]?.status ?? null;
}

async function budgetStatusOf(budgetId: string): Promise<string | undefined> {
  const rows = await prisma.$queryRaw<{ status: string }[]>`
    SELECT status::text AS status FROM budget WHERE id = ${budgetId}::uuid`;
  return rows[0]?.status;
}

describe('budgets.defaultDecision', () => {
  it('RF-M11-10 Decisión por defecto: pasados 7 días con acción "Descartar" el período queda defaulted y el período en curso no tiene arrastre', async () => {
    const s = await closedBudget({ amount: '800.00', spent: '650.00', action: 'discard' });

    await jobsAt(AFTER_DEADLINE).defaultDecision();

    const rows = await periodsOf(s.budgetId);
    expect(rows.find((row) => row.id === s.periodId)?.status).toBe('defaulted');
    expect(rows.find((row) => row.start === '2090-11-01')).toMatchObject({
      carryoverIn: '0.00',
      status: 'open',
    });
    expect(await decisionStatusOf(s.userId, s.periodId)).toBe('resolved');
  });

  it('RF-M11-10 ante un exceso, descartar equivale a absorber: queda defaulted y sin arrastre negativo', async () => {
    const s = await closedBudget({ amount: '500.00', spent: '600.00', action: 'discard' });

    await jobsAt(AFTER_DEADLINE).defaultDecision();

    const rows = await periodsOf(s.budgetId);
    expect(rows.find((row) => row.id === s.periodId)?.status).toBe('defaulted');
    expect(rows.find((row) => row.start === '2090-11-01')?.carryoverIn).toBe('0.00');
    expect(await decisionStatusOf(s.userId, s.periodId)).toBe('resolved');
  });

  it('RF-M11-10 con acción "Arrastrar" el sobrante pasa al período siguiente', async () => {
    const s = await closedBudget({ amount: '800.00', spent: '650.00', action: 'carry' });

    await jobsAt(AFTER_DEADLINE).defaultDecision();

    const rows = await periodsOf(s.budgetId);
    expect(rows.find((row) => row.id === s.periodId)?.status).toBe('defaulted');
    expect(rows.find((row) => row.start === '2090-11-01')?.carryoverIn).toBe('150.00');
  });

  it('RF-M11-10 con acción "Arrastrar" un exceso pasa como arrastre negativo', async () => {
    const s = await closedBudget({ amount: '500.00', spent: '600.00', action: 'carry' });

    await jobsAt(AFTER_DEADLINE).defaultDecision();

    const rows = await periodsOf(s.budgetId);
    expect(rows.find((row) => row.start === '2090-11-01')?.carryoverIn).toBe('-100.00');
  });

  it('RF-M11-10 un presupuesto finalizado no arrastra aunque su acción sea "Arrastrar"', async () => {
    const s = await closedBudget({
      amount: '800.00',
      spent: '650.00',
      action: 'carry',
      status: 'finalizing',
    });

    await jobsAt(AFTER_DEADLINE).defaultDecision();

    const rows = await periodsOf(s.budgetId);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.status).toBe('defaulted');
    expect(await budgetStatusOf(s.budgetId)).toBe('finalized');
  });

  it('RF-M11-10 antes del plazo no se aplica la acción por defecto', async () => {
    const s = await closedBudget({ amount: '800.00', spent: '650.00', action: 'carry' });

    await jobsAt(new Date(CLOSE_AT.getTime() + 6 * DAY_MS)).defaultDecision();

    const rows = await periodsOf(s.budgetId);
    expect(rows.find((row) => row.id === s.periodId)?.status).toBe('closed_pending');
    expect(rows.find((row) => row.start === '2090-11-01')?.carryoverIn).toBe('0.00');
    expect(await decisionStatusOf(s.userId, s.periodId)).toBe('waiting');
  });

  it('RNF-13 correrlo dos veces no duplica ni cambia lo ya resuelto', async () => {
    const s = await closedBudget({ amount: '800.00', spent: '650.00', action: 'carry' });
    const jobs = jobsAt(AFTER_DEADLINE);

    await jobs.defaultDecision();
    const first = await periodsOf(s.budgetId);
    await jobs.defaultDecision();

    expect(await periodsOf(s.budgetId)).toEqual(first);
    expect(first).toHaveLength(2);
  });

  it('RNF-12 un usuario que decide en el mismo instante que el job deja una sola decisión', async () => {
    const s = await closedBudget({ amount: '800.00', spent: '650.00', action: 'discard' });
    const ctx: RatesContext = {
      userId: s.userId,
      timezone: TZ,
      now: AFTER_DEADLINE,
      traceId: uuidv7(),
    };

    const outcomes = await Promise.allSettled([
      jobsAt(AFTER_DEADLINE).defaultDecision(),
      budgets.decide(
        ctx,
        s.budgetId,
        s.periodId,
        DecisionInput.parse({ result: 'surplus', carry: '0.00', discard: '150.00' }),
      ),
    ]);

    expect(outcomes.some((outcome) => outcome.status === 'fulfilled')).toBe(true);
    const rows = await periodsOf(s.budgetId);
    expect(rows).toHaveLength(2);
    const closed = rows.find((row) => row.id === s.periodId);
    expect(['decided', 'defaulted']).toContain(closed?.status);
    expect(closed?.resultAtDecision).not.toBeNull();
    expect(rows.find((row) => row.start === '2090-11-01')?.carryoverIn).toBe('0.00');
    expect(await decisionStatusOf(s.userId, s.periodId)).toBe('resolved');
  });
});
