import { uuidv7 } from 'uuidv7';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { createScheduledNotifications } from '../../src/application/jobs/notifications.js';
import type { Clock } from '../../src/application/ports/clock.js';
import type { RatesContext } from '../../src/application/services/rates.service.js';
import { buildContainer, type Container } from '../../src/composition/container.js';
import { parseEnv } from '../../src/infrastructure/config/env.js';
import { createAccount } from '../factories/account.factory.js';
import { createGoal, deleteGoalsOf } from '../factories/goal.factory.js';
import {
  categoryIdOf,
  createLedgerTransaction,
  deleteLedgerOf,
} from '../factories/ledger.factory.js';
import { createUser, deleteCreatedUsers, type TestUser } from '../factories/user.factory.js';
import { disconnectTestPrisma, testDatabaseUrl, testPrisma } from './setup/db.js';

/**
 * TASK-240: the goal progress notices of RF-M15-02 (type `goal_progress`, off by default).
 * - Milestones (plan §4.12.3): they are evaluated after each earmark event, after each entry of a
 *   dedicated account (a `LedgerHooks` handler) and after the hourly rates job, and each one emits
 *   `goal:{id}:milestone:{25|50|75|100}` once (RF-M15-04, RNF-12), even if the exchange rate makes
 *   it oscillate or the currency of the goal changes (RF-M12-01).
 * - Monthly notice: on day 1 of each month, from 08:00 local, if last month's contribution
 *   (earmarks + entries to the dedicated account − withdrawals) was below the suggested one.
 *
 * The plan fixes no signature for `shared/goal-milestones.ts`, so these tests go through the
 * interfaces that already exist, wired by the container (`RELEASE=1.2`, `INTEGRATIONS=fake`):
 * - `goalsService.earmark` / `release` / `update` (the earmark events and the currency change);
 * - `transactionsService.create` on a dedicated account (the ledger hook);
 * - `testSupport.setRates`, which forces `fx.fetchParallel` of `application/jobs/fx.ts` with the
 *   fake sources (the hourly rates job);
 * - `createScheduledNotifications({ uow, clock, release, users })` of TASK-215, whose `run` is the
 *   `notifications.scheduled` job and sends the monthly notice.
 * The monthly notice is the `goal_progress` notification whose key is not a milestone one.
 *
 * `market_rate` is global (ADR-12): the file saves its rows, empties the table and puts them back.
 * The goals with foreign currency use the real clock, the one `fx.fetchParallel` stores rates with.
 */
const envSource = (): Record<string, string> => ({
  NODE_ENV: 'test',
  PORT: '3000',
  DATABASE_URL: testDatabaseUrl(),
  AUTH_SECRET: 'auth-secret-for-the-goal-milestones-test',
  HMAC_SECRET: 'hmac-secret-for-the-goal-milestones-test',
  JOBS_SECRET: 'jobs-secret-for-the-goal-milestones-test',
  RESEND_API_KEY: 'resend-key-for-the-goal-milestones-test',
  RELEASE: '1.2',
  WEB_ORIGIN: 'http://localhost:5173',
  INTEGRATIONS: 'fake',
});

interface SavedRate {
  kind: string;
  rateDate: string;
  value: string;
  observedAt: Date;
  source: string;
}

let container: Container;
let savedRates: SavedRate[] = [];
const userIds: string[] = [];

beforeAll(async () => {
  container = await Promise.resolve(buildContainer(parseEnv(envSource())));
  savedRates = await testPrisma().$queryRaw<SavedRate[]>`
    SELECT kind::text AS kind, rate_date::text AS "rateDate", value::text AS value,
           observed_at AS "observedAt", source::text AS source
      FROM market_rate`;
  await testPrisma().$executeRaw`DELETE FROM market_rate`;
});

afterAll(async () => {
  const db = testPrisma();
  await db.$executeRaw`DELETE FROM market_rate`;
  for (const row of savedRates) {
    await db.$executeRaw`
      INSERT INTO market_rate (kind, rate_date, value, observed_at, source)
      VALUES (${row.kind}::market_rate_kind, ${row.rateDate}::date, ${row.value}::numeric,
              ${row.observedAt}, ${row.source}::rate_source)`;
  }
  await deleteGoalsOf(userIds);
  await deleteLedgerOf(userIds);
  await deleteCreatedUsers();
  await container.prisma.$disconnect();
  await disconnectTestPrisma();
});

// ---------- Helpers ----------

const LA_PAZ = 'America/La_Paz'; // UTC-4, no daylight saving.

/** The instant of that local time in La Paz (UTC-4). */
const laPaz = (date: string, time: string): Date => new Date(`${date}T${time}:00-04:00`);

function clockAt(instant: Date): Clock {
  return {
    now: () => instant,
    todayFor: (timezone) =>
      new Intl.DateTimeFormat('en-CA', {
        timeZone: timezone,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
      }).format(instant),
  };
}

const ctxFor = (userId: string, now: Date = new Date()): RatesContext => ({
  userId,
  timezone: LA_PAZ,
  now,
  traceId: 'goal-milestones-test',
});

async function newUser(options: { goalProgress?: boolean } = {}): Promise<TestUser> {
  const user = await createUser({ timezone: LA_PAZ });
  userIds.push(user.id);
  if (options.goalProgress ?? true) {
    await testPrisma().$executeRaw`
      UPDATE notification_preference SET enabled = true
       WHERE user_id = ${user.id}::uuid AND type = 'goal_progress'::notification_type`;
  }
  return user;
}

/** Sets the parallel rate (bid = ask = median) and runs the hourly rates job on it. */
async function setUsdRate(value: string): Promise<void> {
  const support = container.testSupport;
  if (support === null) throw new Error('testSupport requires INTEGRATIONS=fake');
  await support.setRates({ median: value, bid: value, ask: value, official: '6.96' });
}

interface NotificationRow {
  eventKey: string;
}

/** The `goal_progress` notices of the user, by key. */
async function goalNoticesOf(userId: string): Promise<string[]> {
  const rows = await testPrisma().$queryRaw<NotificationRow[]>`
    SELECT event_key AS "eventKey"
      FROM notification
     WHERE user_id = ${userId}::uuid AND type = 'goal_progress'::notification_type
     ORDER BY event_key`;
  return rows.map((row) => row.eventKey);
}

/** The milestone keys of that goal that were notified, in order. */
async function milestonesOf(userId: string, goalId: string): Promise<string[]> {
  return (await goalNoticesOf(userId)).filter((key) => key.startsWith(`goal:${goalId}:milestone:`));
}

const milestone = (goalId: string, n: 25 | 50 | 75 | 100): string => `goal:${goalId}:milestone:${n}`;

/** The monthly notices of the user: the `goal_progress` ones that are not milestones. */
async function monthlyNoticesOf(userId: string): Promise<string[]> {
  return (await goalNoticesOf(userId)).filter((key) => !key.includes(':milestone:'));
}

async function earmark(
  user: TestUser,
  goalId: string,
  accountId: string,
  amount: string,
  now?: Date,
): Promise<void> {
  await container.goalsService.earmark(ctxFor(user.id, now), goalId, {
    id: uuidv7(),
    accountId,
    amount,
  });
}

/** An allocation event written by SQL at that instant, for last month's contribution. */
async function allocationAt(
  userId: string,
  goalId: string,
  accountId: string,
  amount: string,
  createdAt: Date,
): Promise<void> {
  await testPrisma().$executeRaw`
    INSERT INTO goal_allocation_event (id, user_id, goal_id, account_id, amount, origin, created_at)
    VALUES (${uuidv7()}::uuid, ${userId}::uuid, ${goalId}::uuid, ${accountId}::uuid,
            ${amount}::numeric, 'manual'::allocation_origin, ${createdAt})`;
}

async function runScheduledAt(instant: Date, user: TestUser): Promise<void> {
  const scheduled = [{ id: user.id, timezone: user.timezone }];
  await createScheduledNotifications({
    uow: container.uow,
    clock: clockAt(instant),
    release: '1.2',
    users: {
      all: () => Promise.resolve(scheduled),
      find: (userId: string) =>
        Promise.resolve(scheduled.find((candidate) => candidate.id === userId) ?? null),
    },
  }).run();
}

// ---------- Milestones ----------

describe('hitos de avance de una meta', () => {
  beforeEach(async () => {
    await setUsdRate('7.00');
  });

  it('RF-M15-02 un apartado que cruza el 25 % avisa el hito 25', async () => {
    const user = await newUser();
    const account = await createAccount(user.id, { initialBalance: '2000.00' });
    const goal = await createGoal(user.id, { target: '1000.00', currencyCode: 'BOB' });

    await earmark(user, goal.id, account.id, '200.00');
    expect(await milestonesOf(user.id, goal.id)).toEqual([]);

    await earmark(user, goal.id, account.id, '100.00');
    expect(await milestonesOf(user.id, goal.id)).toEqual([milestone(goal.id, 25)]);
  });

  it('RF-M15-02 los hitos 50, 75 y 100 se avisan al cruzarlos', async () => {
    const user = await newUser();
    const account = await createAccount(user.id, { initialBalance: '2000.00' });
    const goal = await createGoal(user.id, { target: '1000.00', currencyCode: 'BOB' });

    await earmark(user, goal.id, account.id, '300.00');
    await earmark(user, goal.id, account.id, '250.00');
    expect(await milestonesOf(user.id, goal.id)).toEqual([
      milestone(goal.id, 25),
      milestone(goal.id, 50),
    ]);
    await earmark(user, goal.id, account.id, '200.00');
    await earmark(user, goal.id, account.id, '250.00');

    expect(await milestonesOf(user.id, goal.id)).toEqual([
      milestone(goal.id, 100),
      milestone(goal.id, 25),
      milestone(goal.id, 50),
      milestone(goal.id, 75),
    ]);
  });

  it('RF-M15-02 con el aviso de metas apagado (por defecto) no se avisa ningún hito', async () => {
    const user = await newUser({ goalProgress: false });
    const account = await createAccount(user.id, { initialBalance: '2000.00' });
    const goal = await createGoal(user.id, { target: '1000.00', currencyCode: 'BOB' });

    await earmark(user, goal.id, account.id, '300.00');

    expect(await goalNoticesOf(user.id)).toEqual([]);
  });

  it('RF-M15-02 un ingreso en la cuenta dedicada avisa el hito que cruza', async () => {
    const user = await newUser();
    const now = laPaz('2090-06-15', '12:00');
    const dedicated = await createAccount(user.id, { type: 'savings' });
    const goal = await createGoal(user.id, {
      target: '1000.00',
      currencyCode: 'BOB',
      dedicatedAccountId: dedicated.id,
    });
    const categoryId = await categoryIdOf(user.id, 'income');
    const income = (amount: string) =>
      container.transactionsService.create(ctxFor(user.id, now), {
        kind: 'income',
        id: uuidv7(),
        accountId: dedicated.id,
        categoryId,
        amount,
        date: '2090-06-15',
      });

    await income('300.00');
    expect(await milestonesOf(user.id, goal.id)).toEqual([milestone(goal.id, 25)]);

    await income('200.00');
    expect(await milestonesOf(user.id, goal.id)).toEqual([
      milestone(goal.id, 25),
      milestone(goal.id, 50),
    ]);
  });

  it('RF-M15-04 la dedicada baja del 50 % y vuelve a cruzarlo sin un segundo aviso', async () => {
    const user = await newUser();
    const now = laPaz('2090-06-15', '12:00');
    const dedicated = await createAccount(user.id, { type: 'savings' });
    const goal = await createGoal(user.id, {
      target: '1000.00',
      currencyCode: 'BOB',
      dedicatedAccountId: dedicated.id,
    });
    const income = await categoryIdOf(user.id, 'income');
    const expense = await categoryIdOf(user.id, 'expense');
    const create = (kind: 'income' | 'expense', amount: string) =>
      container.transactionsService.create(ctxFor(user.id, now), {
        kind,
        id: uuidv7(),
        accountId: dedicated.id,
        categoryId: kind === 'income' ? income : expense,
        amount,
        date: '2090-06-15',
      });

    await create('income', '500.00');
    await create('expense', '100.00');
    await create('income', '100.00');

    const keys = await milestonesOf(user.id, goal.id);
    expect(keys.filter((key) => key === milestone(goal.id, 50))).toHaveLength(1);
  });

  it('RF-M15-02 el job de tasas avisa el hito que el tipo de cambio hace cruzar', async () => {
    const user = await newUser();
    const account = await createAccount(user.id, {
      initialBalance: '2000.00',
      initialBalanceDate: '2026-01-01',
    });
    const goal = await createGoal(user.id, { target: '100.00', currencyCode: 'USD' });

    // 340 Bs at 7.00 are 48.57 USD: below 50 %.
    await earmark(user, goal.id, account.id, '340.00');
    expect(await milestonesOf(user.id, goal.id)).toEqual([milestone(goal.id, 25)]);

    // At 6.80 they are 50.00 USD.
    await setUsdRate('6.80');

    expect(await milestonesOf(user.id, goal.id)).toEqual([
      milestone(goal.id, 25),
      milestone(goal.id, 50),
    ]);
  });

  it('RF-M15-04 Sin duplicados: el progreso baja y vuelve a cruzar el 50 % sin otro aviso', async () => {
    const user = await newUser();
    const account = await createAccount(user.id, {
      initialBalance: '2000.00',
      initialBalanceDate: '2026-01-01',
    });
    const goal = await createGoal(user.id, { name: 'Viaje', target: '100.00', currencyCode: 'USD' });
    await earmark(user, goal.id, account.id, '340.00');
    await setUsdRate('6.80');
    expect(await milestonesOf(user.id, goal.id)).toContain(milestone(goal.id, 50));

    await setUsdRate('7.00');
    await setUsdRate('6.80');

    expect(await milestonesOf(user.id, goal.id)).toEqual([
      milestone(goal.id, 25),
      milestone(goal.id, 50),
    ]);
  });

  it('RNF-12 un aviso de hito se genera una sola vez aunque el tipo de cambio oscile', async () => {
    const user = await newUser();
    const account = await createAccount(user.id, {
      initialBalance: '2000.00',
      initialBalanceDate: '2026-01-01',
    });
    const goal = await createGoal(user.id, { target: '100.00', currencyCode: 'USD' });
    await earmark(user, goal.id, account.id, '340.00');

    for (const rate of ['6.80', '7.00', '6.80', '7.00', '6.80']) {
      await setUsdRate(rate);
    }

    const keys = await milestonesOf(user.id, goal.id);
    expect(keys.filter((key) => key === milestone(goal.id, 50))).toHaveLength(1);
    expect(keys.filter((key) => key === milestone(goal.id, 25))).toHaveLength(1);
  });

  it('RF-M12-01 cambiar la moneda de la meta no repite los hitos ya avisados', async () => {
    const user = await newUser();
    const account = await createAccount(user.id, {
      initialBalance: '2000.00',
      initialBalanceDate: '2026-01-01',
    });
    const goal = await createGoal(user.id, { target: '1000.00', currencyCode: 'BOB' });
    await earmark(user, goal.id, account.id, '300.00');
    await earmark(user, goal.id, account.id, '200.00');
    expect(await milestonesOf(user.id, goal.id)).toEqual([
      milestone(goal.id, 25),
      milestone(goal.id, 50),
    ]);

    // 500 Bs at 7.00 are 71.43 USD of 100 USD; 570 Bs are 81.43 USD and cross the 75 %.
    await container.goalsService.update(ctxFor(user.id), goal.id, {
      currencyCode: 'USD',
      target: '100.00',
    });
    await earmark(user, goal.id, account.id, '70.00');

    expect(await milestonesOf(user.id, goal.id)).toEqual([
      milestone(goal.id, 25),
      milestone(goal.id, 50),
      milestone(goal.id, 75),
    ]);
  });

  it('RF-M12-01 volver a la moneda anterior y recruzar un hito no lo avisa otra vez', async () => {
    const user = await newUser();
    const account = await createAccount(user.id, {
      initialBalance: '2000.00',
      initialBalanceDate: '2026-01-01',
    });
    const goal = await createGoal(user.id, { target: '1000.00', currencyCode: 'BOB' });
    await earmark(user, goal.id, account.id, '300.00');
    await earmark(user, goal.id, account.id, '200.00');

    // In USD the 500 Bs are 71.43 of 1000 USD (7 %); back in BOB they are 50 % again.
    await container.goalsService.update(ctxFor(user.id), goal.id, { currencyCode: 'USD' });
    await earmark(user, goal.id, account.id, '1.00');
    await container.goalsService.update(ctxFor(user.id), goal.id, { currencyCode: 'BOB' });
    await earmark(user, goal.id, account.id, '1.00');

    expect(await milestonesOf(user.id, goal.id)).toEqual([
      milestone(goal.id, 25),
      milestone(goal.id, 50),
    ]);
  });
});

// ---------- Monthly notice ----------

describe('aviso mensual del aporte a una meta', () => {
  const JULY_1 = '2090-07-01';
  const MAY = laPaz('2090-05-15', '12:00');
  const JUNE = laPaz('2090-06-15', '12:00');

  /** A goal of 1200 Bs for 2091-06-30 with an account of 5000 Bs: about 50 Bs a month. */
  async function goalWithAccount(user: TestUser, dedicated = false) {
    const account = await createAccount(user.id, {
      type: dedicated ? 'savings' : 'bank',
      initialBalance: dedicated ? '0.00' : '5000.00',
    });
    const goal = await createGoal(user.id, {
      target: '1200.00',
      currencyCode: 'BOB',
      dedicatedAccountId: dedicated ? account.id : null,
    });
    await testPrisma().$executeRaw`
      UPDATE goal SET target_date = '2091-06-30'::date WHERE id = ${goal.id}::uuid`;
    return { account, goal };
  }

  it('RF-M15-02 el día 1 a las 08:00 avisa si el mes anterior se aportó menos que lo sugerido', async () => {
    const user = await newUser();
    const { account, goal } = await goalWithAccount(user);
    await allocationAt(user.id, goal.id, account.id, '600.00', MAY);

    await runScheduledAt(laPaz(JULY_1, '08:30'), user);

    expect(await monthlyNoticesOf(user.id)).toHaveLength(1);
  });

  it('RF-M15-02 no avisa si el mes anterior se apartó más que lo sugerido', async () => {
    const user = await newUser();
    const { account, goal } = await goalWithAccount(user);
    await allocationAt(user.id, goal.id, account.id, '600.00', JUNE);

    await runScheduledAt(laPaz(JULY_1, '08:30'), user);

    expect(await monthlyNoticesOf(user.id)).toEqual([]);
  });

  it('RF-M15-02 las entradas a la cuenta dedicada cuentan como aporte del mes', async () => {
    const user = await newUser();
    const { account } = await goalWithAccount(user, true);
    await createLedgerTransaction(user.id, {
      kind: 'income',
      date: '2090-06-10',
      entries: [{ accountId: account.id, amount: '600.00' }],
    });

    await runScheduledAt(laPaz(JULY_1, '08:30'), user);

    expect(await monthlyNoticesOf(user.id)).toEqual([]);
  });

  it('RF-M15-02 los retiros del mes se restan del aporte', async () => {
    const user = await newUser();
    const { account, goal } = await goalWithAccount(user);
    await allocationAt(user.id, goal.id, account.id, '600.00', MAY);
    await allocationAt(user.id, goal.id, account.id, '300.00', JUNE);
    await allocationAt(user.id, goal.id, account.id, '-300.00', JUNE);

    await runScheduledAt(laPaz(JULY_1, '08:30'), user);

    expect(await monthlyNoticesOf(user.id)).toHaveLength(1);
  });

  it('RF-M15-02 antes de las 08:00 del día 1 todavía no avisa', async () => {
    const user = await newUser();
    const { account, goal } = await goalWithAccount(user);
    await allocationAt(user.id, goal.id, account.id, '600.00', MAY);

    await runScheduledAt(laPaz(JULY_1, '07:30'), user);

    expect(await monthlyNoticesOf(user.id)).toEqual([]);
  });

  it('RF-M15-02 un día que no es el 1 del mes no avisa', async () => {
    const user = await newUser();
    const { account, goal } = await goalWithAccount(user);
    await allocationAt(user.id, goal.id, account.id, '600.00', laPaz('2090-04-15', '12:00'));

    await runScheduledAt(laPaz('2090-06-15', '08:30'), user);

    expect(await monthlyNoticesOf(user.id)).toEqual([]);
  });

  it('RF-M15-02 con el aviso de metas apagado (por defecto) no hay aviso mensual', async () => {
    const user = await newUser({ goalProgress: false });
    const { account, goal } = await goalWithAccount(user);
    await allocationAt(user.id, goal.id, account.id, '600.00', MAY);

    await runScheduledAt(laPaz(JULY_1, '08:30'), user);

    expect(await goalNoticesOf(user.id)).toEqual([]);
  });

  it('RNF-12 correr el job dos veces el día 1 deja un solo aviso mensual', async () => {
    const user = await newUser();
    const { account, goal } = await goalWithAccount(user);
    await allocationAt(user.id, goal.id, account.id, '600.00', MAY);

    await runScheduledAt(laPaz(JULY_1, '08:30'), user);
    await runScheduledAt(laPaz(JULY_1, '10:00'), user);

    expect(await monthlyNoticesOf(user.id)).toHaveLength(1);
  });
});
