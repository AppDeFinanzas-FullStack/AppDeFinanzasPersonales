import { uuidv7 } from 'uuidv7';
import { afterAll, describe, expect, it } from 'vitest';

import type { Clock } from '../../src/application/ports/clock.js';
import type { BudgetRepository } from '../../src/application/ports/repositories.js';
import type { UnitOfWork } from '../../src/application/ports/unit-of-work.js';
import {
  createNotificationEmitter,
  type NotificationEmitter,
} from '../../src/application/shared/notification-emitter.js';
import { buildContainer } from '../../src/composition/container.js';
import { parseEnv } from '../../src/infrastructure/config/env.js';
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
  thresholdHitsOf,
} from '../factories/budget.factory.js';
import { createCategory } from '../factories/category.factory.js';
import { deleteLedgerOf } from '../factories/ledger.factory.js';
import { createUser, deleteCreatedUsers } from '../factories/user.factory.js';
import { disconnectTestPrisma, testDatabaseUrl, testPrisma } from './setup/db.js';

/**
 * Assumptions (tasks.md TASK-200 fixes the behaviour and that the job lives in
 * `application/jobs/budgets.ts`; plan §4.0 fixes `registerJob(name, run, { forUser })` and
 * `catchUpUser(userId)`; the factory name and its deps are not fixed):
 * - `budgets.ts` exports `createBudgetsJobs({ uow, clock, notifications, ids })`, which returns
 *   `{ close, closeForUser }`: `close()` is the `budgets.close` handler of the tick (every user)
 *   and `closeForUser(userId)` its per-user scope for the catch-up (ADR-01).
 * - "Today" is the date of `clock.now()` in the user's timezone (RNF-20), and the decision deadline
 *   is `clock.now() + 7 days`: the instant the close is generated (RF-M11-10).
 * - The next period starts the day after the closed one ends, with the amount of the budget and
 *   `carryover_in = 0`; with `next_start_day` it ends the day before that day of the next month,
 *   and from then on the budget renews on that day.
 * - The close notice is a `period_close` notification with event key `period_close:{periodId}`,
 *   waiting for the decision `budget_period` of that period (plan §4.15.3).
 * - The start-threshold evaluation of the new period records only the highest crossed threshold
 *   in `budget_threshold_hit` and its notice `budget_alert:{periodId}:{threshold}` (RF-M11-13).
 */
interface BudgetsJobsUnderTest {
  close(): Promise<void>;
  closeForUser(userId: string): Promise<void>;
}
type CreateBudgetsJobs = (deps: {
  uow: UnitOfWork;
  clock: Clock;
  notifications: NotificationEmitter;
  ids: { next: () => string };
}) => BudgetsJobsUnderTest;

const { createBudgetsJobs } =
  (await import('../../src/application/jobs/budgets.js')) as unknown as {
    createBudgetsJobs: CreateBudgetsJobs;
  };

const NIL_USER = '00000000-0000-0000-0000-000000000000';
const prisma = testPrisma();
const usedUserIds: string[] = [];

/**
 * The test database is shared with the other suites, and `close()` at 2090 would catch up every
 * budget they left behind (hundreds of periods each, growing run after run). `close()` still finds
 * its owners through the repository, but only among the users of this file.
 */
function ownUsersOnly(repo: BudgetRepository): BudgetRepository {
  return {
    ...repo,
    async ownersWithEndedPeriods(now) {
      const owners = await repo.ownersWithEndedPeriods(now);
      return owners.filter((owner) => usedUserIds.includes(owner));
    },
  };
}

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
  budgets: ownUsersOnly(createBudgetRepository(tx, userId ?? NIL_USER)),
  budgetPeriods: createBudgetPeriodRepository(tx, userId ?? NIL_USER),
}));

const notifications = createNotificationEmitter({ release: '1.1' });
const ids = { next: () => uuidv7() };

const DAY_MS = 24 * 60 * 60_000;
const LA_PAZ = 'America/La_Paz';
const MAY = { startDate: '2090-05-01', endDate: '2090-05-31' };

afterAll(async () => {
  await deleteBudgetsOf(usedUserIds);
  await deleteLedgerOf(usedUserIds);
  await deleteCreatedUsers();
  await disconnectTestPrisma();
});

/** The date of an instant in a timezone, as `YYYY-MM-DD`. */
const dateIn = (timezone: string, instant: Date): string =>
  new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(instant);

/** A clock that stays at `instant`. */
const clockAt = (instant: Date): Clock => ({
  now: () => new Date(instant.getTime()),
  todayFor: (timezone) => dateIn(timezone, instant),
});

const jobsAt = (instant: Date): BudgetsJobsUnderTest =>
  createBudgetsJobs({ uow, clock: clockAt(instant), notifications, ids });

interface Setup {
  userId: string;
  accountId: string;
  categoryId: string;
  budget: TestBudget;
}

async function setup(
  options: {
    timezone?: string;
    status?: TestBudgetStatus;
    thresholds?: number[];
    startDay?: number;
  } = {},
): Promise<Setup> {
  const user = await createUser({ timezone: options.timezone ?? LA_PAZ });
  usedUserIds.push(user.id);
  const account = await createAccount(user.id, { initialBalance: '10000.00' });
  const category = await createCategory(user.id);
  const budget = await createBudget(user.id, {
    categoryId: category.id,
    amount: '500.00',
    thresholds: options.thresholds ?? [80, 100],
    status: options.status ?? 'active',
    startDay: options.startDay ?? 1,
  });
  return { userId: user.id, accountId: account.id, categoryId: category.id, budget };
}

interface PeriodRow {
  id: string;
  start: string;
  end: string;
  amount: string;
  carryoverIn: string;
  status: string;
  decisionDeadline: Date | null;
}

async function periodsOf(budgetId: string): Promise<PeriodRow[]> {
  return prisma.$queryRaw<PeriodRow[]>`
    SELECT id::text AS id, to_char(start_date, 'YYYY-MM-DD') AS start,
           to_char(end_date, 'YYYY-MM-DD') AS "end", amount::text AS amount,
           carryover_in::text AS "carryoverIn", status::text AS status,
           decision_deadline AS "decisionDeadline"
      FROM budget_period WHERE budget_id = ${budgetId}::uuid ORDER BY start_date`;
}

async function budgetStatusOf(budgetId: string): Promise<string | undefined> {
  const rows = await prisma.$queryRaw<{ status: string }[]>`
    SELECT status::text AS status FROM budget WHERE id = ${budgetId}::uuid`;
  return rows[0]?.status;
}

interface NotificationRow {
  type: string;
  eventKey: string;
  decisionKind: string | null;
  decisionRef: string | null;
  decisionStatus: string | null;
}

async function notificationsOf(userId: string): Promise<NotificationRow[]> {
  return prisma.$queryRaw<NotificationRow[]>`
    SELECT type::text AS type, event_key AS "eventKey", decision_kind AS "decisionKind",
           decision_ref::text AS "decisionRef", decision_status::text AS "decisionStatus"
      FROM notification WHERE user_id = ${userId}::uuid ORDER BY event_key`;
}

const byStart = (rows: PeriodRow[], start: string): PeriodRow | undefined =>
  rows.find((row) => row.start === start);

describe('budgets.close', () => {
  it('RF-M11-10 tras una caída de 3 días el cierre se genera al volver y el plazo de 7 días cuenta desde ese momento', async () => {
    const s = await setup();
    const may = await createBudgetPeriod(s.userId, s.budget, MAY);
    // May ended on 2090-05-31; the system comes back three days later.
    const back = new Date('2090-06-03T15:00:00Z');

    await jobsAt(back).close();

    const rows = await periodsOf(s.budget.id);
    const closed = rows.find((row) => row.id === may.id);
    expect(closed?.status).toBe('closed_pending');
    expect(closed?.decisionDeadline?.getTime()).toBe(back.getTime() + 7 * DAY_MS);
  });

  it('RF-M11-10 antes de que termine el período no se cierra nada', async () => {
    const s = await setup();
    const may = await createBudgetPeriod(s.userId, s.budget, MAY);

    await jobsAt(new Date('2090-05-31T15:00:00Z')).close();

    const rows = await periodsOf(s.budget.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.id).toBe(may.id);
    expect(rows[0]?.status).toBe('open');
    expect(rows[0]?.decisionDeadline).toBeNull();
  });

  it('TASK-200 crea el período siguiente abierto, con el monto del presupuesto y carryover_in = 0', async () => {
    const s = await setup();
    await createBudgetPeriod(s.userId, s.budget, { ...MAY, carryoverIn: '50.00' });

    await jobsAt(new Date('2090-06-01T15:00:00Z')).close();

    const june = byStart(await periodsOf(s.budget.id), '2090-06-01');
    expect(june).toMatchObject({
      end: '2090-06-30',
      amount: '500.00',
      carryoverIn: '0.00',
      status: 'open',
      decisionDeadline: null,
    });
  });

  it('TASK-200 emite el aviso period_close:{periodId} que espera la decisión del período', async () => {
    const s = await setup();
    const may = await createBudgetPeriod(s.userId, s.budget, MAY);

    await jobsAt(new Date('2090-06-01T15:00:00Z')).close();

    const closeNotices = (await notificationsOf(s.userId)).filter(
      (row) => row.type === 'period_close',
    );
    expect(closeNotices).toEqual([
      {
        type: 'period_close',
        eventKey: `period_close:${may.id}`,
        decisionKind: 'budget_period',
        decisionRef: may.id,
        decisionStatus: 'waiting',
      },
    ]);
  });

  it('TASK-200 el período siguiente aplica next_start_day y desde ahí el presupuesto se renueva en ese día', async () => {
    const s = await setup({ startDay: 1 });
    await prisma.$executeRaw`
      UPDATE budget SET next_start_day = 15 WHERE id = ${s.budget.id}::uuid`;
    // The period in course was already extended to the day before the new start day (RF-M11-07).
    await createBudgetPeriod(s.userId, s.budget, {
      startDate: '2090-05-01',
      endDate: '2090-06-14',
    });

    await jobsAt(new Date('2090-06-16T15:00:00Z')).close();

    const next = byStart(await periodsOf(s.budget.id), '2090-06-15');
    expect(next?.end).toBe('2090-07-14');
    expect(next?.status).toBe('open');

    await jobsAt(new Date('2090-07-16T15:00:00Z')).close();

    const after = byStart(await periodsOf(s.budget.id), '2090-07-15');
    expect(after?.end).toBe('2090-08-14');
  });

  it('RF-M11-13 si el período siguiente empieza ya por encima de umbrales solo se avisa el más alto cruzado', async () => {
    const s = await setup({ thresholds: [50, 80, 100] });
    await createBudgetPeriod(s.userId, s.budget, MAY);
    // Spent while the close had not run yet: 450 of 500 is 90 % of the June period.
    await createSpend(s.userId, {
      accountId: s.accountId,
      categoryId: s.categoryId,
      date: '2090-06-02',
      amount: '450.00',
    });

    await jobsAt(new Date('2090-06-03T15:00:00Z')).close();

    const june = byStart(await periodsOf(s.budget.id), '2090-06-01');
    expect(june).toBeDefined();
    expect(await thresholdHitsOf(june?.id ?? '')).toEqual([80]);
    const alerts = (await notificationsOf(s.userId)).filter((row) => row.type === 'budget_alert');
    expect(alerts.map((row) => row.eventKey)).toEqual([`budget_alert:${june?.id ?? ''}:80`]);
  });

  it('RF-M11-13 si el período siguiente empieza por debajo de los umbrales no avisa', async () => {
    const s = await setup({ thresholds: [50, 80, 100] });
    await createBudgetPeriod(s.userId, s.budget, MAY);
    await createSpend(s.userId, {
      accountId: s.accountId,
      categoryId: s.categoryId,
      date: '2090-06-02',
      amount: '100.00',
    });

    await jobsAt(new Date('2090-06-03T15:00:00Z')).close();

    const june = byStart(await periodsOf(s.budget.id), '2090-06-01');
    expect(await thresholdHitsOf(june?.id ?? '')).toEqual([]);
    const alerts = (await notificationsOf(s.userId)).filter((row) => row.type === 'budget_alert');
    expect(alerts).toEqual([]);
  });

  it('RNF-13 correrlo dos veces no crea dos períodos ni dos avisos', async () => {
    const s = await setup();
    const may = await createBudgetPeriod(s.userId, s.budget, MAY);
    const first = new Date('2090-06-02T15:00:00Z');

    await jobsAt(first).close();
    await jobsAt(new Date(first.getTime() + 60_000)).close();

    const rows = await periodsOf(s.budget.id);
    expect(rows.map((row) => row.start)).toEqual(['2090-05-01', '2090-06-01']);
    // The second run does not move the deadline.
    expect(rows[0]?.decisionDeadline?.getTime()).toBe(first.getTime() + 7 * DAY_MS);
    const closeNotices = (await notificationsOf(s.userId)).filter(
      (row) => row.type === 'period_close',
    );
    expect(closeNotices.map((row) => row.eventKey)).toEqual([`period_close:${may.id}`]);
  });

  it('RNF-13 dos corridas a la vez no crean dos períodos ni dos avisos', async () => {
    const s = await setup();
    const may = await createBudgetPeriod(s.userId, s.budget, MAY);
    const jobs = jobsAt(new Date('2090-06-02T15:00:00Z'));

    await Promise.all([jobs.close(), jobs.closeForUser(s.userId)]);

    const rows = await periodsOf(s.budget.id);
    expect(rows.map((row) => row.start)).toEqual(['2090-05-01', '2090-06-01']);
    const closeNotices = (await notificationsOf(s.userId)).filter(
      (row) => row.type === 'period_close',
    );
    expect(closeNotices.map((row) => row.eventKey)).toEqual([`period_close:${may.id}`]);
  });

  it('EC-M11-09 un presupuesto finalizing pasa a finalized sin período siguiente', async () => {
    const s = await setup({ status: 'finalizing' });
    const may = await createBudgetPeriod(s.userId, s.budget, MAY);

    await jobsAt(new Date('2090-06-02T15:00:00Z')).close();

    const rows = await periodsOf(s.budget.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.id).toBe(may.id);
    expect(rows[0]?.status).toBe('closed_pending');
    expect(await budgetStatusOf(s.budget.id)).toBe('finalized');
    const closeNotices = (await notificationsOf(s.userId)).filter(
      (row) => row.type === 'period_close',
    );
    expect(closeNotices.map((row) => row.eventKey)).toEqual([`period_close:${may.id}`]);
  });

  it('RNF-20 el cierre usa la medianoche de la zona del usuario', async () => {
    // 2090-05-31T20:00Z is already June 1st in Tokyo and still May 31st in La Paz.
    const instant = new Date('2090-05-31T20:00:00Z');
    const tokyo = await setup({ timezone: 'Asia/Tokyo' });
    const laPaz = await setup({ timezone: LA_PAZ });
    const tokyoMay = await createBudgetPeriod(tokyo.userId, tokyo.budget, MAY);
    const laPazMay = await createBudgetPeriod(laPaz.userId, laPaz.budget, MAY);

    await jobsAt(instant).close();

    const tokyoRows = await periodsOf(tokyo.budget.id);
    expect(tokyoRows.find((row) => row.id === tokyoMay.id)?.status).toBe('closed_pending');
    expect(byStart(tokyoRows, '2090-06-01')?.status).toBe('open');
    const laPazRows = await periodsOf(laPaz.budget.id);
    expect(laPazRows).toHaveLength(1);
    expect(laPazRows[0]?.id).toBe(laPazMay.id);
    expect(laPazRows[0]?.status).toBe('open');
  });

  it('TASK-200 closeForUser cierra solo los períodos de ese usuario', async () => {
    const mine = await setup();
    const other = await setup();
    const myMay = await createBudgetPeriod(mine.userId, mine.budget, MAY);
    const otherMay = await createBudgetPeriod(other.userId, other.budget, MAY);

    await jobsAt(new Date('2090-06-02T15:00:00Z')).closeForUser(mine.userId);

    const myRows = await periodsOf(mine.budget.id);
    expect(myRows.find((row) => row.id === myMay.id)?.status).toBe('closed_pending');
    expect(myRows).toHaveLength(2);
    const otherRows = await periodsOf(other.budget.id);
    expect(otherRows).toHaveLength(1);
    expect(otherRows[0]?.id).toBe(otherMay.id);
    expect(otherRows[0]?.status).toBe('open');
    expect(await notificationsOf(other.userId)).toEqual([]);
  });
});

describe('budgets.close en el contenedor', () => {
  const envSource = (): Record<string, string> => ({
    NODE_ENV: 'test',
    PORT: '3000',
    DATABASE_URL: testDatabaseUrl(),
    AUTH_SECRET: 'auth-secret-for-the-budgets-close-test',
    HMAC_SECRET: 'hmac-secret-for-the-budgets-close-test',
    JOBS_SECRET: 'jobs-secret-for-the-budgets-close-test',
    RESEND_API_KEY: 'resend-key-for-the-budgets-close-test',
    RELEASE: '1.1',
    WEB_ORIGIN: 'http://localhost:5173',
    INTEGRATIONS: 'fake',
  });

  it('TASK-200 el contenedor registra budgets.close en el tick', async () => {
    const container = await Promise.resolve(buildContainer(parseEnv(envSource())));
    try {
      expect(() => {
        container.jobs.registerJob('budgets.close', () => Promise.resolve());
      }).toThrow();
    } finally {
      await container.prisma.$disconnect();
    }
  });

  it('TASK-200 la puesta al día del usuario cierra su período vencido', async () => {
    const s = await setup();
    const now = new Date();
    const today = dateIn(LA_PAZ, now);
    const yesterday = dateIn(LA_PAZ, new Date(now.getTime() - DAY_MS));
    const monthAgo = dateIn(LA_PAZ, new Date(now.getTime() - 30 * DAY_MS));
    const period = await createBudgetPeriod(s.userId, s.budget, {
      startDate: monthAgo,
      endDate: yesterday,
    });
    expect(today > yesterday).toBe(true);

    const container = await Promise.resolve(buildContainer(parseEnv(envSource())));
    try {
      await container.jobs.catchUpUser(s.userId);
    } finally {
      await container.prisma.$disconnect();
    }

    const rows = await periodsOf(s.budget.id);
    expect(rows.find((row) => row.id === period.id)?.status).toBe('closed_pending');
    expect(rows).toHaveLength(2);
  });
});
