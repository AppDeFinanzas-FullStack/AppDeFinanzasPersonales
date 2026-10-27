import type { CreateAccountInput, PaymentInput } from '@finanzas/contracts';
import { Decimal } from 'decimal.js';
import { uuidv7 } from 'uuidv7';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { AppError } from '../../src/application/errors.js';
import { createBudgetsJobs } from '../../src/application/jobs/budgets.js';
import { createScheduledNotifications } from '../../src/application/jobs/notifications.js';
import { createRecurringJobs } from '../../src/application/jobs/recurring.js';
import { createJobs, type JobName } from '../../src/application/jobs/tick.js';
import type { Clock } from '../../src/application/ports/clock.js';
import type { Repositories } from '../../src/application/ports/repositories.js';
import type { UnitOfWork } from '../../src/application/ports/unit-of-work.js';
import type { RatesContext } from '../../src/application/services/rates.service.js';
import { createNotificationEmitter } from '../../src/application/shared/notification-emitter.js';
import { buildContainer, type Container } from '../../src/composition/container.js';
import { parseEnv } from '../../src/infrastructure/config/env.js';
import { createJobRuns } from '../../src/infrastructure/persistence/job-runs.js';
import { createAccount } from '../factories/account.factory.js';
import { createBudget, createBudgetPeriod, deleteBudgetsOf } from '../factories/budget.factory.js';
import { createCategory } from '../factories/category.factory.js';
import { createDebt, findStoredDebt, storedPaymentIdsOf } from '../factories/debt.factory.js';
import { createGoal, deleteGoalsOf } from '../factories/goal.factory.js';
import { categoryIdOf, deleteLedgerOf } from '../factories/ledger.factory.js';
import { createRule, deleteRecurringOf, uniqueRuleName } from '../factories/recurring.factory.js';
import { expenseInput } from '../factories/transaction.factory.js';
import { createUser, deleteCreatedUsers } from '../factories/user.factory.js';
import { disconnectTestPrisma, testDatabaseUrl, testPrisma } from './setup/db.js';

/**
 * Concurrency sweep (plan §5.1, §4.3.3): the operations of the plan that must not corrupt data when
 * two of them overlap are launched together with `Promise.all`, each one in its own transaction on
 * its own connection of the pool, and the result is read straight from the database. The services
 * are the ones of the real container, with the interfaces already fixed by their own tasks:
 * - `currenciesService.create/deactivate(ctx, ...)` and `accountsService.create(ctx, input)`.
 * - `debtsService.pay(ctx, debtId, input)` and `debtsService.deleteLastPayment(ctx, debtId)`.
 * - `goalsService.earmark(ctx, goalId, input)` and `transactionsService.create(ctx, input)`.
 * - `createJobs({ jobRuns, clock, release })`, whose `tick()` takes the lease of each job in
 *   `job_run`, with the real `budgets.close`, `recurring.generate` and `notifications.scheduled`
 *   built like the ones of the jobs-resume tests and restricted to the users of the test.
 * The order in which two overlapping operations are decided is not fixed, so each test accepts
 * every valid order and checks what must hold in all of them.
 */
const envSource = (): Record<string, string> => ({
  NODE_ENV: 'test',
  PORT: '3000',
  DATABASE_URL: testDatabaseUrl(),
  AUTH_SECRET: 'auth-secret-for-the-concurrency-sweep-0123456789',
  HMAC_SECRET: 'hmac-secret-for-the-concurrency-sweep-0123456789',
  JOBS_SECRET: 'jobs-secret-for-the-concurrency-sweep-0123456789',
  RESEND_API_KEY: 're_resend-key-for-the-concurrency-sweep',
  RELEASE: '1.2',
  WEB_ORIGIN: 'http://localhost:5173',
  INTEGRATIONS: 'fake',
});

const prisma = testPrisma();
const TZ = 'America/La_Paz'; // UTC-4, no daylight saving.
const TEST_TIMEOUT_MS = 60_000;
const usedUserIds: string[] = [];
const TICK_JOBS: JobName[] = ['recurring.generate', 'budgets.close', 'notifications.scheduled'];

let container: Container;

beforeAll(async () => {
  container = await Promise.resolve(buildContainer(parseEnv(envSource())));
});

afterAll(async () => {
  await prisma.$executeRaw`DELETE FROM job_run WHERE job = ANY(${TICK_JOBS}::text[])`;
  await deleteRecurringOf(usedUserIds);
  await deleteBudgetsOf(usedUserIds);
  await deleteGoalsOf(usedUserIds);
  await deleteLedgerOf(usedUserIds);
  await deleteCreatedUsers();
  await container.prisma.$disconnect();
  await disconnectTestPrisma();
});

// ---------- Helpers ----------

async function newUser(): Promise<string> {
  const user = await createUser({ timezone: TZ });
  usedUserIds.push(user.id);
  return user.id;
}

const ctxAt = (userId: string, now: Date): RatesContext => ({
  userId,
  timezone: TZ,
  now,
  traceId: uuidv7(),
});

const sleep = (ms: number) =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });

/** A clock that stays at `instant`. */
function clockAt(instant: Date): Clock {
  return {
    now: () => new Date(instant.getTime()),
    todayFor: (timezone) =>
      new Intl.DateTimeFormat('en-CA', {
        timeZone: timezone,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
      }).format(instant),
  };
}

/** The instant of that local time in La Paz (UTC-4). */
const laPaz = (date: string, time: string): Date => new Date(`${date}T${time}:00-04:00`);

/** The error a rejected operation threw, as an `AppError`. */
function appErrorOf(result: PromiseSettledResult<unknown>): AppError {
  if (result.status !== 'rejected') {
    throw new Error('The operation was expected to be rejected');
  }
  expect(result.reason).toBeInstanceOf(AppError);
  return result.reason as AppError;
}

/** Launches both operations at once, the first one first on even rounds and second on odd ones. */
async function together<A, B>(
  round: number,
  first: () => Promise<A>,
  second: () => Promise<B>,
): Promise<[PromiseSettledResult<A>, PromiseSettledResult<B>]> {
  if (round % 2 === 0) {
    return Promise.allSettled([first(), second()]);
  }
  const [b, a] = await Promise.allSettled([second(), first()]);
  return [a, b];
}

/** Current balance of the account through the ledger (RN-01). */
async function balanceOf(userId: string, accountId: string): Promise<Decimal> {
  const balances = await container.uow.run(
    (repos: Repositories) => repos.ledger.balances([accountId]),
    { userLock: userId, readOnly: true },
  );
  return balances.get(accountId) ?? new Decimal(NaN);
}

// ---------- Deactivating a currency while an account is created in it ----------

const CURRENCY = 'EUR';

async function currencyStatus(userId: string): Promise<string | undefined> {
  const rows = await prisma.$queryRaw<{ status: string }[]>`
    SELECT status::text AS status FROM currency
     WHERE user_id = ${userId}::uuid AND code = ${CURRENCY}`;
  return rows[0]?.status;
}

async function accountsIn(userId: string): Promise<number> {
  const rows = await prisma.$queryRaw<{ n: number }[]>`
    SELECT count(*)::int AS n FROM account
     WHERE user_id = ${userId}::uuid AND currency_code = ${CURRENCY} AND status = 'active'`;
  return rows[0]?.n ?? 0;
}

function accountInput(): CreateAccountInput {
  return {
    id: uuidv7(),
    type: 'bank',
    name: `Cuenta ${uuidv7().slice(-8)}`,
    currencyCode: CURRENCY,
    initialBalance: '0.00',
    initialBalanceDate: '2090-01-01',
    color: 'blue',
    icon: 'wallet',
  };
}

interface CurrencyRace {
  userId: string;
  deactivation: PromiseSettledResult<void>;
  creation: PromiseSettledResult<unknown>;
}

/** A user with the added currency EUR and the two operations launched at once. */
async function raceCurrency(round: number): Promise<CurrencyRace> {
  const userId = await newUser();
  const now = new Date();
  await container.currenciesService.create(ctxAt(userId, now), {
    code: CURRENCY,
    symbol: '€',
    rate: new Decimal('7.50'),
  });
  const [deactivation, creation] = await together(
    round,
    () => container.currenciesService.deactivate(ctxAt(userId, new Date()), CURRENCY),
    () => container.accountsService.create(ctxAt(userId, new Date()), accountInput()),
  );
  return { userId, deactivation, creation };
}

describe(
  'TASK-246 desactivar una moneda mientras se crea una cuenta en ella',
  { timeout: TEST_TIMEOUT_MS },
  () => {
    it('TASK-246 la moneda queda activa con la cuenta creada, o inactiva sin ella, nunca las dos cosas', async () => {
      for (let round = 0; round < 6; round += 1) {
        const { userId } = await raceCurrency(round);

        const status = await currencyStatus(userId);
        const accounts = await accountsIn(userId);

        const consistent =
          (status === 'active' && accounts === 1) || (status === 'inactive' && accounts === 0);
        expect({ round, status, accounts, consistent }).toEqual({
          round,
          status,
          accounts,
          consistent: true,
        });
      }
    });

    it('RNF-10 una de las dos operaciones gana con el estado vigente de la moneda y la otra responde con su error', async () => {
      for (let round = 0; round < 6; round += 1) {
        const { userId, deactivation, creation } = await raceCurrency(round);

        if (deactivation.status === 'fulfilled') {
          expect(creation.status).toBe('rejected');
          expect(appErrorOf(creation).code).toBe('CURRENCY_INACTIVE');
          expect(await currencyStatus(userId)).toBe('inactive');
          expect(await accountsIn(userId)).toBe(0);
        } else {
          expect(creation.status).toBe('fulfilled');
          const error = appErrorOf(deactivation);
          expect(error.code).toBe('CURRENCY_IN_USE');
          expect(error.data?.['usedBy']).toBeDefined();
          expect(await currencyStatus(userId)).toBe('active');
          expect(await accountsIn(userId)).toBe(1);
        }
      }
    });

    it('RNF-11 dos creaciones de la misma cuenta con el mismo id mientras se desactiva la moneda dejan una sola cuenta', async () => {
      const userId = await newUser();
      await container.currenciesService.create(ctxAt(userId, new Date()), {
        code: CURRENCY,
        symbol: '€',
        rate: new Decimal('7.50'),
      });
      const input = accountInput();

      await Promise.allSettled([
        container.accountsService.create(ctxAt(userId, new Date()), input),
        container.accountsService.create(ctxAt(userId, new Date()), input),
        container.currenciesService.deactivate(ctxAt(userId, new Date()), CURRENCY),
      ]);

      const accounts = await accountsIn(userId);
      expect(accounts).toBeLessThanOrEqual(1);
      expect(await currencyStatus(userId)).toBe(accounts === 1 ? 'active' : 'inactive');
    });
  },
);

// ---------- Two ticks in parallel ----------

const OUTAGE = new Date('2092-07-03T15:00:00Z');
const RECURRING_START = '2092-03-01';
/** 12:00 of 2092-03-04 in La Paz: the system was down since 2092-03-01. */
const RECURRING_NOW = laPaz('2092-03-04', '12:00');
/** 21:00 of 2092-10-20 in La Paz: past 08:00 and at the default hour of `log_day`. */
const NOTICES_NOW = laPaz('2092-10-20', '21:00');

/** The job only sees the users of the test, as the database is shared with the other suites. */
function scopedUow(budgetOwners: string[]): UnitOfWork {
  return {
    run: (fn, opts) =>
      container.uow.run(async (repos: Repositories) => {
        const budgets = repos.budgets;
        const scoped: Repositories = {
          ...repos,
          budgets: {
            ...budgets,
            async ownersWithEndedPeriods(now) {
              const owners = await budgets.ownersWithEndedPeriods(now);
              return owners.filter((owner) => budgetOwners.includes(owner));
            },
          },
        };
        return fn(scoped);
      }, opts),
  };
}

interface BudgetUser {
  userId: string;
  budgetId: string;
}

/** A user whose May budget period ended and whose system was down until July 3rd. */
async function budgetUser(): Promise<BudgetUser> {
  const userId = await newUser();
  await createAccount(userId, { initialBalance: '10000.00', initialBalanceDate: '2092-01-01' });
  const category = await createCategory(userId);
  const budget = await createBudget(userId, {
    categoryId: category.id,
    amount: '500.00',
    thresholds: [80, 100],
  });
  await createBudgetPeriod(userId, budget, { startDate: '2092-05-01', endDate: '2092-05-31' });
  return { userId, budgetId: budget.id };
}

interface RecurringUser {
  userId: string;
  autoRuleId: string;
  confirmRuleId: string;
}

async function insertDailyRule(
  userId: string,
  options: {
    accountId: string;
    categoryId: string;
    amount: string | null;
    endCount: number | null;
  },
): Promise<string> {
  const id = uuidv7();
  const mode = options.amount === null ? 'confirm' : 'auto';
  const endType = options.endCount === null ? 'none' : 'count';
  await prisma.$executeRaw`
    INSERT INTO recurring_rule (id, user_id, name, kind, amount, account_id, dest_account_id,
                                category_id, frequency, start_date, end_type, end_date, end_count,
                                mode, status, paused_at, generated_count, last_generated_date)
    VALUES (${id}::uuid, ${userId}::uuid, ${uniqueRuleName('Diaria')}, 'expense'::entry_kind,
            ${options.amount}::numeric, ${options.accountId}::uuid, NULL::uuid,
            ${options.categoryId}::uuid, 'daily', ${RECURRING_START}::date,
            ${endType}::rule_end_type, NULL::date, ${options.endCount}::smallint,
            ${mode}::rule_mode, 'active'::rule_status, NULL::timestamptz, 0::int, NULL::date)`;
  return id;
}

/**
 * A user with two daily rules since 2092-03-01: an automatic expense of 20.00 with no end and a
 * rule in confirmation mode that ends after 3 occurrences.
 */
async function recurringUser(): Promise<RecurringUser> {
  const userId = await newUser();
  const account = await createAccount(userId, {
    type: 'bank',
    initialBalance: '100000.00',
    initialBalanceDate: '2092-01-01',
  });
  const category = await createCategory(userId, { kind: 'expense' });
  const common = { accountId: account.id, categoryId: category.id };
  const autoRuleId = await insertDailyRule(userId, { ...common, amount: '20.00', endCount: null });
  const confirmRuleId = await insertDailyRule(userId, { ...common, amount: null, endCount: 3 });
  return { userId, autoRuleId, confirmRuleId };
}

/** A user with a debt due in 3 days, a debt due today, a rule paid tomorrow and "Registrar el día". */
async function noticeUser(): Promise<string> {
  const userId = await newUser();
  await createDebt(userId, { dueDate: '2092-10-23', startDate: '2092-01-01' });
  await createDebt(userId, {
    direction: 'owed_to_me',
    person: 'Ana',
    dueDate: '2092-10-20',
    startDate: '2092-01-01',
  });
  await createRule(userId, { dayOfMonth: 21, startDate: '2092-01-21', amount: '100.00' });
  await prisma.$executeRaw`
    UPDATE notification_preference SET enabled = true
     WHERE user_id = ${userId}::uuid AND type = 'log_day'::notification_type`;
  return userId;
}

interface Batch {
  budget: BudgetUser[];
  recurring: RecurringUser[];
  notices: string[];
}

async function newBatch(): Promise<Batch> {
  return {
    budget: [await budgetUser(), await budgetUser()],
    recurring: [await recurringUser(), await recurringUser()],
    notices: [await noticeUser(), await noticeUser()],
  };
}

interface JobBodies {
  generate: () => Promise<void>;
  close: () => Promise<void>;
  scheduled: () => Promise<void>;
}

/** The three real jobs, over the users of the batch only. */
function jobBodies(batch: Batch): JobBodies {
  const recurringIds = batch.recurring.map((user) => user.userId);
  const recurring = createRecurringJobs({
    uow: container.uow,
    generator: container.recurringGenerator,
    users: {
      withActiveRules: () => Promise.resolve(recurringIds),
      withExpiredPending: () => Promise.resolve([]),
      async timezoneOf(userId) {
        const rows = await prisma.$queryRaw<{ timezone: string }[]>`
          SELECT timezone FROM auth_user WHERE id = ${userId}::uuid`;
        return rows[0]?.timezone ?? null;
      },
    },
    clock: clockAt(RECURRING_NOW),
  });
  const budgets = createBudgetsJobs({
    uow: scopedUow(batch.budget.map((user) => user.userId)),
    clock: clockAt(OUTAGE),
    notifications: createNotificationEmitter({ release: '1.2' }),
    ids: { next: () => uuidv7() },
  });
  const scheduled = batch.notices.map((id) => ({ id, timezone: TZ }));
  const notices = createScheduledNotifications({
    uow: container.uow,
    clock: clockAt(NOTICES_NOW),
    release: '1.2',
    users: {
      all: () => Promise.resolve(scheduled),
      find: (userId) => Promise.resolve(scheduled.find((user) => user.id === userId) ?? null),
    },
  });
  return {
    generate: () => recurring.generate(),
    close: () => budgets.close(),
    scheduled: () => notices.run(),
  };
}

/** What the ticks did: the runs that got past the lease and the most runs of one job in flight. */
interface TickLog {
  calls: string[];
  inFlight: Map<string, number>;
  peak: Map<string, number>;
}

/**
 * One process: a registry of jobs whose handlers wait a moment after taking their lease, so the
 * other process arrives while it is held. `log` records every run that got past the lease and,
 * per job, how many runs were in progress at the same time.
 */
function tickProcess(bodies: JobBodies, log: TickLog) {
  const jobs = createJobs({
    jobRuns: createJobRuns(prisma),
    clock: clockAt(OUTAGE),
    release: '1.2',
  });
  const slow = (name: string, run: () => Promise<void>) => async (): Promise<void> => {
    log.calls.push(name);
    const running = (log.inFlight.get(name) ?? 0) + 1;
    log.inFlight.set(name, running);
    log.peak.set(name, Math.max(log.peak.get(name) ?? 0, running));
    try {
      await sleep(150);
      await run();
    } finally {
      log.inFlight.set(name, (log.inFlight.get(name) ?? 1) - 1);
    }
  };
  jobs.registerJob('recurring.generate', slow('recurring.generate', bodies.generate));
  jobs.registerJob('budgets.close', slow('budgets.close', bodies.close));
  jobs.registerJob('notifications.scheduled', slow('notifications.scheduled', bodies.scheduled));
  return jobs;
}

async function tickTwice(bodies: JobBodies): Promise<TickLog> {
  const log: TickLog = { calls: [], inFlight: new Map(), peak: new Map() };
  await Promise.all([tickProcess(bodies, log).tick(), tickProcess(bodies, log).tick()]);
  return log;
}

interface PeriodRow {
  start: string;
  status: string;
}

async function periodsOf(budgetId: string): Promise<PeriodRow[]> {
  return prisma.$queryRaw<PeriodRow[]>`
    SELECT to_char(start_date, 'YYYY-MM-DD') AS start, status::text AS status
      FROM budget_period WHERE budget_id = ${budgetId}::uuid ORDER BY start_date`;
}

async function occurrenceDatesOf(ruleId: string): Promise<string[]> {
  const rows = await prisma.$queryRaw<{ scheduledDate: string }[]>`
    SELECT to_char(scheduled_date, 'YYYY-MM-DD') AS "scheduledDate"
      FROM recurring_occurrence WHERE rule_id = ${ruleId}::uuid ORDER BY scheduled_date`;
  return rows.map((row) => row.scheduledDate);
}

async function liveTransactionsOf(userId: string): Promise<number> {
  const rows = await prisma.$queryRaw<{ n: number }[]>`
    SELECT count(*)::int AS n FROM ledger_transaction
     WHERE user_id = ${userId}::uuid AND deleted_at IS NULL`;
  return rows[0]?.n ?? 0;
}

async function noticeKeysOf(userId: string, type: string): Promise<string[]> {
  const rows = await prisma.$queryRaw<{ eventKey: string }[]>`
    SELECT event_key AS "eventKey" FROM notification
     WHERE user_id = ${userId}::uuid AND type = ${type}::notification_type ORDER BY event_key`;
  return rows.map((row) => row.eventKey);
}

const unique = (values: string[]): boolean => new Set(values).size === values.length;

/** Every decision of the batch is taken once: periods, occurrences, movements and notices. */
async function expectEffectsOnce(batch: Batch): Promise<void> {
  for (const { budgetId, userId } of batch.budget) {
    // May and June are closed once each and July is the only open period (RF-M11-10).
    expect(await periodsOf(budgetId)).toEqual([
      { start: '2092-05-01', status: 'closed_pending' },
      { start: '2092-06-01', status: 'closed_pending' },
      { start: '2092-07-01', status: 'open' },
    ]);
    const closings = await noticeKeysOf(userId, 'period_close');
    expect(closings).toHaveLength(2);
    expect(unique(closings)).toBe(true);
  }
  for (const user of batch.recurring) {
    expect(await occurrenceDatesOf(user.autoRuleId)).toEqual([
      '2092-03-01',
      '2092-03-02',
      '2092-03-03',
      '2092-03-04',
    ]);
    expect(await occurrenceDatesOf(user.confirmRuleId)).toEqual([
      '2092-03-01',
      '2092-03-02',
      '2092-03-03',
    ]);
    expect(await liveTransactionsOf(user.userId)).toBe(4);
    const pending = await noticeKeysOf(user.userId, 'recurring_pending');
    expect(pending).toHaveLength(3);
    expect(unique(pending)).toBe(true);
  }
  for (const userId of batch.notices) {
    expect(await noticeKeysOf(userId, 'log_day')).toHaveLength(1);
    const upcoming = await noticeKeysOf(userId, 'payment_upcoming');
    expect(upcoming).toHaveLength(3);
    expect(unique(upcoming)).toBe(true);
  }
}

async function leasesOf(): Promise<{ job: string; lockedUntil: Date | null }[]> {
  return prisma.$queryRaw<{ job: string; lockedUntil: Date | null }[]>`
    SELECT job, locked_until AS "lockedUntil" FROM job_run WHERE job = ANY(${TICK_JOBS}::text[])`;
}

describe('TASK-246 dos ticks en paralelo', { timeout: TEST_TIMEOUT_MS }, () => {
  it('RNF-12 con dos ticks a la vez cada período se decide una vez y cada ocurrencia se genera una vez', async () => {
    const batch = await newBatch();

    await tickTwice(jobBodies(batch));

    await expectEffectsOnce(batch);
  });

  it('RNF-12 con dos ticks a la vez cada aviso se genera una sola vez por evento', async () => {
    const batch = await newBatch();

    await tickTwice(jobBodies(batch));

    for (const { userId } of batch.budget) {
      const keys = await prisma.$queryRaw<{ eventKey: string }[]>`
        SELECT event_key AS "eventKey" FROM notification WHERE user_id = ${userId}::uuid`;
      expect(unique(keys.map((row) => row.eventKey))).toBe(true);
    }
    for (const userId of batch.notices) {
      const keys = await prisma.$queryRaw<{ eventKey: string }[]>`
        SELECT event_key AS "eventKey" FROM notification WHERE user_id = ${userId}::uuid`;
      expect(keys).toHaveLength(4);
      expect(unique(keys.map((row) => row.eventKey))).toBe(true);
    }
  });

  it('TASK-246 el lease deja pasar a lo sumo una corrida de cada job a la vez y queda libre al terminar', async () => {
    const batch = await newBatch();

    const log = await tickTwice(jobBodies(batch));

    // Both ticks start together and each handler waits while it holds its lease: the second tick
    // finds the lease held and skips the job, so no job ever has two runs in progress at once.
    for (const name of TICK_JOBS) {
      expect(log.calls.filter((call) => call === name).length).toBeGreaterThanOrEqual(1);
      expect(log.peak.get(name)).toBe(1);
    }
    const leases = await leasesOf();
    expect(leases.map((lease) => lease.job).sort()).toEqual([...TICK_JOBS].sort());
    expect(leases.every((lease) => lease.lockedUntil === null)).toBe(true);
  });

  it('RNF-11 si el lease venció y dos corridas del mismo job se solapan, el resultado es el de una sola', async () => {
    const batch = await newBatch();
    const bodies = jobBodies(batch);

    await Promise.all([
      bodies.generate(),
      bodies.generate(),
      bodies.close(),
      bodies.close(),
      bodies.scheduled(),
      bodies.scheduled(),
    ]);

    await expectEffectsOnce(batch);
  });
});

// ---------- A debt payment and the removal of its last payment at the same time ----------

const TODAY = '2090-06-15';
const NOW = new Date('2090-06-15T16:00:00Z'); // 12:00 in La Paz

function paymentOf(accountId: string, amount: string): PaymentInput {
  return {
    id: uuidv7(),
    amount,
    interestPart: '0.00',
    capitalPart: amount,
    date: TODAY,
    account: {
      accountId,
      capitalTransactionId: uuidv7(),
      interestTransactionId: uuidv7(),
    },
  };
}

async function livePaymentMovements(userId: string): Promise<number> {
  const rows = await prisma.$queryRaw<{ n: number }[]>`
    SELECT count(*)::int AS n FROM ledger_transaction
     WHERE user_id = ${userId}::uuid AND origin = 'debt_payment' AND deleted_at IS NULL`;
  return rows[0]?.n ?? 0;
}

describe(
  'TASK-246 un pago de deuda y la eliminación de su último pago al mismo tiempo',
  { timeout: TEST_TIMEOUT_MS },
  () => {
    it('RNF-10 queda un solo pago y la deuda, el saldo de la cuenta y los movimientos coinciden con él', async () => {
      for (let round = 0; round < 6; round += 1) {
        const userId = await newUser();
        const account = await createAccount(userId, {
          type: 'bank',
          initialBalance: '5000.00',
          initialBalanceDate: '2090-01-01',
        });
        const debt = await createDebt(userId, { principal: '1000.00', startDate: '2090-01-01' });
        const ctx = ctxAt(userId, NOW);
        const first = paymentOf(account.id, '300.00');
        const second = paymentOf(account.id, '200.00');
        await container.debtsService.pay(ctx, debt.id, first);
        await sleep(20);

        const results = await together(
          round,
          () => container.debtsService.pay(ctx, debt.id, second),
          () => container.debtsService.deleteLastPayment(ctx, debt.id),
        );

        expect(results.map((result) => result.status)).toEqual(['fulfilled', 'fulfilled']);
        const left = await storedPaymentIdsOf(debt.id);
        // The removal came first and took the 300.00 payment, or last and took the 200.00 one.
        const outcomes: Record<string, { outstanding: string; balance: string }> = {
          [first.id]: { outstanding: '700.00', balance: '4700.00' },
          [second.id]: { outstanding: '800.00', balance: '4800.00' },
        };
        expect(left).toHaveLength(1);
        const expected = outcomes[left[0] ?? ''];
        expect(expected).toBeDefined();
        expect((await findStoredDebt(debt.id))?.capitalOutstanding).toBe(expected?.outstanding);
        expect((await balanceOf(userId, account.id)).toFixed(2)).toBe(expected?.balance);
        expect(await livePaymentMovements(userId)).toBe(1);
      }
    });

    it('RNF-11 el mismo pago enviado dos veces a la vez, junto a otro pago, se registra una sola vez', async () => {
      const userId = await newUser();
      const account = await createAccount(userId, {
        type: 'bank',
        initialBalance: '5000.00',
        initialBalanceDate: '2090-01-01',
      });
      const debt = await createDebt(userId, { principal: '1000.00', startDate: '2090-01-01' });
      const ctx = ctxAt(userId, NOW);
      const repeated = paymentOf(account.id, '200.00');
      const other = paymentOf(account.id, '300.00');

      const results = await Promise.all([
        container.debtsService.pay(ctx, debt.id, repeated),
        container.debtsService.pay(ctx, debt.id, repeated),
        container.debtsService.pay(ctx, debt.id, other),
      ]);

      expect(results.filter((result) => result.created)).toHaveLength(2);
      expect((await storedPaymentIdsOf(debt.id)).sort()).toEqual([repeated.id, other.id].sort());
      expect((await findStoredDebt(debt.id))?.capitalOutstanding).toBe('500.00');
      expect((await balanceOf(userId, account.id)).toFixed(2)).toBe('4500.00');
      expect(await livePaymentMovements(userId)).toBe(2);
    });
  },
);

// ---------- Earmarks that together exceed the free balance ----------

async function earmarkedIn(accountId: string): Promise<Decimal> {
  const rows = await prisma.$queryRaw<{ total: string }[]>`
    SELECT COALESCE(sum(amount), 0)::text AS total FROM goal_allocation_event
     WHERE account_id = ${accountId}::uuid`;
  return new Decimal(rows[0]?.total ?? '0');
}

async function allocationEventsIn(accountId: string): Promise<number> {
  const rows = await prisma.$queryRaw<{ n: number }[]>`
    SELECT count(*)::int AS n FROM goal_allocation_event WHERE account_id = ${accountId}::uuid`;
  return rows[0]?.n ?? 0;
}

async function bankWith(userId: string, balance: string): Promise<string> {
  const account = await createAccount(userId, {
    type: 'bank',
    initialBalance: balance,
    initialBalanceDate: '2090-01-01',
  });
  return account.id;
}

describe(
  'TASK-246 dos apartados que superan juntos el saldo libre',
  { timeout: TEST_TIMEOUT_MS },
  () => {
    it('RNF-10 dos apartados de 80 sobre un saldo de 100 no pasan los dos: uno responde EARMARK_EXCEEDS_FREE', async () => {
      for (let round = 0; round < 4; round += 1) {
        const userId = await newUser();
        const accountId = await bankWith(userId, '100.00');
        const a = await createGoal(userId, {});
        const b = await createGoal(userId, {});
        const ctx = ctxAt(userId, NOW);

        const [first, second] = await together(
          round,
          () =>
            container.goalsService.earmark(ctx, a.id, { id: uuidv7(), accountId, amount: '80.00' }),
          () =>
            container.goalsService.earmark(ctx, b.id, { id: uuidv7(), accountId, amount: '80.00' }),
        );

        const results = [first, second];
        expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
        const failed = results.find((result) => result.status === 'rejected');
        expect(appErrorOf(failed as PromiseSettledResult<unknown>).code).toBe(
          'EARMARK_EXCEEDS_FREE',
        );
        expect((await earmarkedIn(accountId)).toFixed(2)).toBe('80.00');
        expect((await balanceOf(userId, accountId)).toFixed(2)).toBe('100.00');
      }
    });

    it('RNF-10 tres apartados de 40 sobre un saldo de 100 dejan apartado 80 y nunca más que el saldo', async () => {
      const userId = await newUser();
      const accountId = await bankWith(userId, '100.00');
      const goals = [
        await createGoal(userId, {}),
        await createGoal(userId, {}),
        await createGoal(userId, {}),
      ];
      const ctx = ctxAt(userId, NOW);

      const results = await Promise.allSettled(
        goals.map((goal) =>
          container.goalsService.earmark(ctx, goal.id, {
            id: uuidv7(),
            accountId,
            amount: '40.00',
          }),
        ),
      );

      expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(2);
      const failed = results.filter((result) => result.status === 'rejected');
      expect(failed.map((result) => appErrorOf(result).code)).toEqual(['EARMARK_EXCEEDS_FREE']);
      const earmarked = await earmarkedIn(accountId);
      expect(earmarked.toFixed(2)).toBe('80.00');
      expect(earmarked.lte(await balanceOf(userId, accountId))).toBe(true);
    });

    it('RNF-10 un apartado y un gasto que juntos superan el saldo: gana uno y el otro se evalúa con el saldo vigente', async () => {
      const userId = await newUser();
      const categoryId = await categoryIdOf(userId, 'expense');
      for (let round = 0; round < 6; round += 1) {
        const accountId = await bankWith(userId, '100.00');
        const goal = await createGoal(userId, {});
        const ctx = ctxAt(userId, NOW);

        const [earmark, expense] = await together(
          round,
          () =>
            container.goalsService.earmark(ctx, goal.id, {
              id: uuidv7(),
              accountId,
              amount: '80.00',
            }),
          () =>
            container.transactionsService.create(
              ctx,
              expenseInput(accountId, categoryId, { amount: '80.00', date: TODAY }),
            ),
        );

        const balance = await balanceOf(userId, accountId);
        const earmarked = await earmarkedIn(accountId);
        expect(earmark.status === 'fulfilled' || expense.status === 'fulfilled').toBe(true);
        expect(earmark.status === 'fulfilled' && expense.status === 'fulfilled').toBe(false);
        if (earmark.status === 'fulfilled') {
          expect(appErrorOf(expense).code).toBe('EARMARK_CONFIRMATION_REQUIRED');
          expect(earmarked.toFixed(2)).toBe('80.00');
          expect(balance.toFixed(2)).toBe('100.00');
        } else {
          expect(appErrorOf(earmark).code).toBe('EARMARK_EXCEEDS_FREE');
          expect(earmarked.toFixed(2)).toBe('0.00');
          expect(balance.toFixed(2)).toBe('20.00');
        }
        expect(balance.minus(earmarked).gte(0)).toBe(true);
      }
    });

    it('RNF-11 el mismo apartado enviado dos veces a la vez deja un solo apartado', async () => {
      const userId = await newUser();
      const accountId = await bankWith(userId, '100.00');
      const goal = await createGoal(userId, {});
      const ctx = ctxAt(userId, NOW);
      const input = { id: uuidv7(), accountId, amount: '60.00' };

      const results = await Promise.allSettled([
        container.goalsService.earmark(ctx, goal.id, input),
        container.goalsService.earmark(ctx, goal.id, input),
      ]);

      expect(results.some((result) => result.status === 'fulfilled')).toBe(true);
      expect(await allocationEventsIn(accountId)).toBe(1);
      expect((await earmarkedIn(accountId)).toFixed(2)).toBe('60.00');
    });
  },
);
