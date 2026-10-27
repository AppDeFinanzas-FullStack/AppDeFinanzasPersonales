import { uuidv7 } from 'uuidv7';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { AppError } from '../../src/application/errors.js';
import { createBudgetsJobs } from '../../src/application/jobs/budgets.js';
import { createScheduledNotifications } from '../../src/application/jobs/notifications.js';
import { createRecurringJobs } from '../../src/application/jobs/recurring.js';
import type { Clock } from '../../src/application/ports/clock.js';
import type { Repositories } from '../../src/application/ports/repositories.js';
import type { UnitOfWork } from '../../src/application/ports/unit-of-work.js';
import { createNotificationEmitter } from '../../src/application/shared/notification-emitter.js';
import { buildContainer, type Container } from '../../src/composition/container.js';
import { parseEnv } from '../../src/infrastructure/config/env.js';
import { createAccount } from '../factories/account.factory.js';
import { createBudget, createBudgetPeriod, deleteBudgetsOf } from '../factories/budget.factory.js';
import { createCategory } from '../factories/category.factory.js';
import { createDebt } from '../factories/debt.factory.js';
import { deleteLedgerOf } from '../factories/ledger.factory.js';
import { deleteRecurringOf, uniqueRuleName } from '../factories/recurring.factory.js';
import { findStoredTransaction, incomeInput } from '../factories/transaction.factory.js';
import { createUser, deleteCreatedUsers, type TestUser } from '../factories/user.factory.js';
import { disconnectTestPrisma, testDatabaseUrl, testPrisma } from './setup/db.js';

/**
 * RNF-20 (plan §5.3): every business date is computed in the timezone of the user's profile. The
 * file runs the processes that depend on a date for users in America/La_Paz (UTC-4, no daylight
 * saving), Europe/Madrid (UTC+1, UTC+2 in summer; the change happens at 02:00) and
 * America/Santiago (UTC-4, UTC-3 in summer; the change happens at midnight, so the 00:00 of the
 * first summer day does not exist and the 23:00 of the last one happens twice), with a clock that
 * stays at the instant the test chooses (plan §5.1). The instants are written in UTC next to the
 * local time they stand for. The years are far in the future (2092) so the data never meets the
 * data of the other suites. The changes of hour of 2092 are:
 * - Europe/Madrid: 2092-03-30 01:00Z (02:00 -> 03:00) and 2092-10-26 01:00Z (03:00 -> 02:00).
 * - America/Santiago: 2092-04-06 03:00Z (24:00 -> 23:00) and 2092-09-07 04:00Z (00:00 -> 01:00).
 *
 * The interfaces are the ones already fixed by the earlier tasks:
 * - `transactionsService.create(ctx, input)` of the container, with `ctx = { userId, timezone, now,
 *   traceId }`, rejects with `FUTURE_DATE` a date after the day of `ctx.now` in `ctx.timezone`
 *   (RN-07).
 * - `createBudgetsJobs({ uow, clock, notifications, ids })` returns `{ close }`.
 * - `createRecurringJobs({ uow, generator, users, clock })` returns `{ generate }`.
 * - `createScheduledNotifications({ uow, clock, release, users })` returns `{ run }`.
 *
 * The budget job walks every user of the database, so the tests give it a `UnitOfWork` that keeps
 * it within the users of the test.
 */
const envSource = (): Record<string, string> => ({
  NODE_ENV: 'test',
  PORT: '3000',
  DATABASE_URL: testDatabaseUrl(),
  AUTH_SECRET: 'auth-secret-for-the-timezones-test-0123456789',
  HMAC_SECRET: 'hmac-secret-for-the-timezones-test-0123456789',
  JOBS_SECRET: 'jobs-secret-for-the-timezones-test-0123456789',
  RESEND_API_KEY: 're_resend-key-for-the-timezones-test',
  RELEASE: '1.2',
  WEB_ORIGIN: 'http://localhost:5173',
  INTEGRATIONS: 'fake',
});

const prisma = testPrisma();
const LA_PAZ = 'America/La_Paz';
const MADRID = 'Europe/Madrid';
const SANTIAGO = 'America/Santiago';
const TEST_TIMEOUT_MS = 60_000;
const usedUserIds: string[] = [];

let container: Container;

beforeAll(async () => {
  container = await Promise.resolve(buildContainer(parseEnv(envSource())));
});

afterAll(async () => {
  await deleteRecurringOf(usedUserIds);
  await deleteBudgetsOf(usedUserIds);
  await deleteLedgerOf(usedUserIds);
  await deleteCreatedUsers();
  await container.prisma.$disconnect();
  await disconnectTestPrisma();
});

// ---------- Helpers ----------

/** The local day of the instant in the timezone, as `YYYY-MM-DD`. */
function localDay(timezone: string, instant: Date): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(instant);
}

/** A clock that stays at an instant until the test moves it. */
interface MovableClock extends Clock {
  moveTo(instant: string): void;
}

function clockAt(initial: string): MovableClock {
  let instant = new Date(initial);
  return {
    moveTo(next) {
      instant = new Date(next);
    },
    now: () => new Date(instant.getTime()),
    todayFor: (timezone) => localDay(timezone, instant),
  };
}

async function newUser(timezone: string): Promise<TestUser> {
  const user = await createUser({ timezone });
  usedUserIds.push(user.id);
  return user;
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

// ---------- RN-07, RNF-20: the date of a movement ----------

interface MovementUser {
  userId: string;
  accountId: string;
  categoryId: string;
}

async function movementUser(timezone: string): Promise<MovementUser> {
  const user = await newUser(timezone);
  const account = await createAccount(user.id, { initialBalanceDate: '2090-01-01' });
  const category = await createCategory(user.id, { kind: 'income' });
  return { userId: user.id, accountId: account.id, categoryId: category.id };
}

function ctxFor(userId: string, timezone: string, instant: string) {
  return { userId, timezone, now: new Date(instant), traceId: uuidv7() };
}

/** The day `day` as a movement date: accepted from its first minute and `FUTURE_DATE` before it. */
async function expectDayStartsAt(
  timezone: string,
  day: string,
  lastMinuteBefore: string,
  firstMinute: string,
): Promise<void> {
  const user = await movementUser(timezone);
  const create = (instant: string, date: string) =>
    container.transactionsService.create(
      ctxFor(user.userId, timezone, instant),
      incomeInput(user.accountId, user.categoryId, { date }),
    );

  const early = await rejectionOf(create(lastMinuteBefore, day));
  expect(early.code).toBe('FUTURE_DATE');
  expect(early.status).toBe(422);

  const previous = new Date(Date.parse(`${day}T00:00:00Z`) - 86_400_000).toISOString().slice(0, 10);
  const lastDay = await create(lastMinuteBefore, previous);
  expect(lastDay.created).toBe(true);

  const first = await create(firstMinute, day);
  expect(first.created).toBe(true);
  expect((await findStoredTransaction(first.transaction.id))?.date).toBe(day);
}

describe('RNF-20 la fecha de un movimiento en la zona del usuario', { timeout: TEST_TIMEOUT_MS }, () => {
  it('RNF-20 en America/La_Paz el día nuevo empieza a las 00:00 (04:00Z)', async () => {
    await expectDayStartsAt(LA_PAZ, '2092-06-15', '2092-06-15T03:59:00Z', '2092-06-15T04:00:00Z');
  });

  it('RNF-20 en Europe/Madrid en verano el día nuevo empieza a las 22:00Z del día anterior', async () => {
    await expectDayStartsAt(MADRID, '2092-06-15', '2092-06-14T21:59:00Z', '2092-06-14T22:00:00Z');
  });

  it('RNF-20 en America/Santiago en verano el día nuevo empieza a las 03:00Z', async () => {
    await expectDayStartsAt(SANTIAGO, '2092-01-15', '2092-01-15T02:59:00Z', '2092-01-15T03:00:00Z');
  });

  it('RNF-20 el mismo instante da días distintos en las tres zonas: ayer en La Paz, hoy en Santiago y Madrid', async () => {
    const instant = '2092-01-15T03:30:00Z';
    const results: Record<string, string> = {};
    for (const timezone of [LA_PAZ, SANTIAGO, MADRID]) {
      const user = await movementUser(timezone);
      try {
        await container.transactionsService.create(
          ctxFor(user.userId, timezone, instant),
          incomeInput(user.accountId, user.categoryId, { date: '2092-01-15' }),
        );
        results[timezone] = 'accepted';
      } catch (error) {
        results[timezone] = error instanceof AppError ? error.code : 'unexpected';
      }
    }

    expect(results).toEqual({
      [LA_PAZ]: 'FUTURE_DATE',
      [SANTIAGO]: 'accepted',
      [MADRID]: 'accepted',
    });
  });

  it('RNF-20 en Madrid el día del cambio a horario de verano (30/03) el siguiente día empieza a las 22:00Z', async () => {
    // Before 01:00Z the offset is +1 and after it +2: the midnight of the 31st is 22:00Z, not 23:00Z.
    await expectDayStartsAt(MADRID, '2092-03-31', '2092-03-30T21:59:00Z', '2092-03-30T22:00:00Z');
  });

  it('RNF-20 en Madrid el día del cambio a horario de invierno (26/10) el siguiente día empieza a las 23:00Z', async () => {
    // The day of the 26th lasts 25 hours: the midnight of the 27th is 23:00Z, not 22:00Z.
    await expectDayStartsAt(MADRID, '2092-10-27', '2092-10-26T22:59:00Z', '2092-10-26T23:00:00Z');
  });

  it('RNF-20 en Santiago el día del cambio a horario de verano (07/09) el 00:00 no existe y el día ya cuenta a las 01:00', async () => {
    await expectDayStartsAt(SANTIAGO, '2092-09-07', '2092-09-07T03:59:00Z', '2092-09-07T04:00:00Z');
  });

  it('RNF-20 en Santiago el día del cambio a horario de invierno (06/04) las 23:00 se repiten y el día nuevo empieza a las 04:00Z', async () => {
    // At 03:30Z the clock shows 23:30 of the 5th for the second time.
    await expectDayStartsAt(SANTIAGO, '2092-04-06', '2092-04-06T03:30:00Z', '2092-04-06T04:00:00Z');
  });

  it('RN-07 cambiar la zona horaria no altera la fecha guardada aunque en la nueva zona quede como futura', async () => {
    const user = await movementUser(MADRID);
    // 22:30Z of the 14th is 00:30 of the 15th in Madrid and 18:30 of the 14th in La Paz.
    const instant = '2092-06-14T22:30:00Z';
    const input = incomeInput(user.accountId, user.categoryId, { date: '2092-06-15' });
    const created = await container.transactionsService.create(
      ctxFor(user.userId, MADRID, instant),
      input,
    );
    expect(created.created).toBe(true);

    await prisma.$executeRaw`
      UPDATE auth_user SET timezone = ${LA_PAZ} WHERE id = ${user.userId}::uuid`;

    expect((await findStoredTransaction(input.id))?.date).toBe('2092-06-15');
    const again = await rejectionOf(
      container.transactionsService.create(
        ctxFor(user.userId, LA_PAZ, instant),
        incomeInput(user.accountId, user.categoryId, { date: '2092-06-15' }),
      ),
    );
    expect(again.code).toBe('FUTURE_DATE');
    expect((await findStoredTransaction(input.id))?.date).toBe('2092-06-15');
  });
});

// ---------- budgets.close ----------

/** The unit of work of the test: the budget job only walks the given users. */
function scopedUow(users: string[]): UnitOfWork {
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
              return owners.filter((owner) => users.includes(owner));
            },
          },
        };
        return fn(scoped);
      }, opts),
  };
}

interface BudgetCase {
  timezone: string;
  startDay: number;
  start: string;
  end: string;
}

interface BudgetUser {
  userId: string;
  budgetId: string;
  periodId: string;
}

async function budgetUser(spec: BudgetCase): Promise<BudgetUser> {
  const user = await newUser(spec.timezone);
  await createAccount(user.id, { initialBalance: '1000.00', initialBalanceDate: '2090-01-01' });
  const category = await createCategory(user.id);
  const budget = await createBudget(user.id, {
    categoryId: category.id,
    amount: '500.00',
    startDay: spec.startDay,
  });
  const period = await createBudgetPeriod(user.id, budget, {
    startDate: spec.start,
    endDate: spec.end,
  });
  return { userId: user.id, budgetId: budget.id, periodId: period.id };
}

async function periodStatus(periodId: string): Promise<string | undefined> {
  const rows = await prisma.$queryRaw<{ status: string }[]>`
    SELECT status::text AS status FROM budget_period WHERE id = ${periodId}::uuid`;
  return rows[0]?.status;
}

/** Runs `budgets.close` at the instant over those users. */
async function closeAt(instant: string, users: BudgetUser[]): Promise<void> {
  const jobs = createBudgetsJobs({
    uow: scopedUow(users.map((user) => user.userId)),
    clock: clockAt(instant),
    notifications: createNotificationEmitter({ release: '1.2' }),
    ids: { next: () => uuidv7() },
  });
  await jobs.close();
}

/** The period ends on `end`; it closes at the first minute of the next local day and not before. */
async function expectClosesAt(
  spec: BudgetCase,
  lastMinuteBefore: string,
  firstMinute: string,
): Promise<void> {
  const user = await budgetUser(spec);

  await closeAt(lastMinuteBefore, [user]);
  expect(await periodStatus(user.periodId)).toBe('open');

  await closeAt(firstMinute, [user]);
  expect(await periodStatus(user.periodId)).toBe('closed_pending');
}

const JANUARY = { startDay: 1, start: '2092-01-01', end: '2092-01-31' };

describe('RNF-20 el cierre de presupuestos usa el día local del usuario', { timeout: TEST_TIMEOUT_MS }, () => {
  it('RNF-20 en La Paz el período que termina el 31/01 se cierra a las 00:00 del 01/02 (04:00Z)', async () => {
    await expectClosesAt(
      { timezone: LA_PAZ, ...JANUARY },
      '2092-02-01T03:59:00Z',
      '2092-02-01T04:00:00Z',
    );
  });

  it('RNF-20 en Madrid (invierno) el período que termina el 31/01 se cierra a las 23:00Z del 31/01', async () => {
    await expectClosesAt(
      { timezone: MADRID, ...JANUARY },
      '2092-01-31T22:59:00Z',
      '2092-01-31T23:00:00Z',
    );
  });

  it('RNF-20 en Santiago (verano) el período que termina el 31/01 se cierra a las 03:00Z del 01/02', async () => {
    await expectClosesAt(
      { timezone: SANTIAGO, ...JANUARY },
      '2092-02-01T02:59:00Z',
      '2092-02-01T03:00:00Z',
    );
  });

  it('RNF-20 con un mismo instante cierra el de Madrid, luego el de Santiago y al final el de La Paz', async () => {
    const batch = [
      await budgetUser({ timezone: LA_PAZ, ...JANUARY }),
      await budgetUser({ timezone: SANTIAGO, ...JANUARY }),
      await budgetUser({ timezone: MADRID, ...JANUARY }),
    ];
    const statuses = async (): Promise<string[]> =>
      Promise.all(batch.map(async (user) => (await periodStatus(user.periodId)) ?? 'missing'));

    // 23:30Z of the 31st: 19:30 in La Paz, 20:30 in Santiago, 00:30 of the 1st in Madrid.
    await closeAt('2092-01-31T23:30:00Z', batch);
    expect(await statuses()).toEqual(['open', 'open', 'closed_pending']);

    // 03:30Z of the 1st: 23:30 of the 31st in La Paz, 00:30 of the 1st in Santiago.
    await closeAt('2092-02-01T03:30:00Z', batch);
    expect(await statuses()).toEqual(['open', 'closed_pending', 'closed_pending']);

    // 04:00Z of the 1st: midnight in La Paz.
    await closeAt('2092-02-01T04:00:00Z', batch);
    expect(await statuses()).toEqual(['closed_pending', 'closed_pending', 'closed_pending']);
  });

  it('RNF-20 en Madrid el período que termina el 26/10 (día de 25 horas) se cierra a las 23:00Z', async () => {
    await expectClosesAt(
      { timezone: MADRID, startDay: 27, start: '2092-09-27', end: '2092-10-26' },
      '2092-10-26T22:59:00Z',
      '2092-10-26T23:00:00Z',
    );
  });

  it('RNF-20 en Santiago el período que termina el 06/09 se cierra al empezar el 07/09, a las 04:00Z', async () => {
    await expectClosesAt(
      { timezone: SANTIAGO, startDay: 7, start: '2092-08-07', end: '2092-09-06' },
      '2092-09-07T03:59:00Z',
      '2092-09-07T04:00:00Z',
    );
  });

  it('RNF-20 en Santiago el período que termina el 05/04 no se cierra en la hora repetida y sí a las 04:00Z', async () => {
    // At 03:30Z it is 23:30 of the 5th for the second time: the day has not ended yet.
    await expectClosesAt(
      { timezone: SANTIAGO, startDay: 6, start: '2092-03-06', end: '2092-04-05' },
      '2092-04-06T03:30:00Z',
      '2092-04-06T04:00:00Z',
    );
  });
});

// ---------- recurring.generate ----------

interface RecurringUser {
  userId: string;
  ruleId: string;
}

/** A daily rule in confirmation mode that starts on `startDate` and never ends. */
async function dailyRuleUser(timezone: string, startDate: string): Promise<RecurringUser> {
  const user = await newUser(timezone);
  const account = await createAccount(user.id, {
    type: 'bank',
    initialBalance: '1000.00',
    initialBalanceDate: '2090-01-01',
  });
  const category = await createCategory(user.id, { kind: 'expense' });
  const ruleId = uuidv7();
  await prisma.$executeRaw`
    INSERT INTO recurring_rule (id, user_id, name, kind, amount, account_id, dest_account_id,
                                category_id, frequency, start_date, end_type, end_date, end_count,
                                mode, status, paused_at, generated_count, last_generated_date)
    VALUES (${ruleId}::uuid, ${user.id}::uuid, ${uniqueRuleName('Diaria')}, 'expense'::entry_kind,
            NULL::numeric, ${account.id}::uuid, NULL::uuid, ${category.id}::uuid, 'daily',
            ${startDate}::date, 'none'::rule_end_type, NULL::date, NULL::smallint,
            'confirm'::rule_mode, 'active'::rule_status, NULL::timestamptz, 0::int, NULL::date)`;
  return { userId: user.id, ruleId };
}

function recurringJobs(users: RecurringUser[], clock: Clock) {
  const ids = users.map((user) => user.userId);
  return createRecurringJobs({
    uow: container.uow,
    generator: container.recurringGenerator,
    users: {
      withActiveRules: () => Promise.resolve(ids),
      withExpiredPending: () => Promise.resolve([]),
      async timezoneOf(userId) {
        const rows = await prisma.$queryRaw<{ timezone: string }[]>`
          SELECT timezone FROM auth_user WHERE id = ${userId}::uuid`;
        return rows[0]?.timezone ?? null;
      },
    },
    clock,
  });
}

async function occurrenceDates(ruleId: string): Promise<string[]> {
  const rows = await prisma.$queryRaw<{ scheduledDate: string }[]>`
    SELECT to_char(scheduled_date, 'YYYY-MM-DD') AS "scheduledDate"
      FROM recurring_occurrence WHERE rule_id = ${ruleId}::uuid ORDER BY scheduled_date`;
  return rows.map((row) => row.scheduledDate);
}

/** Runs `recurring.generate` at each instant and checks the dates the rule has after each run. */
async function expectOccurrences(
  timezone: string,
  startDate: string,
  steps: { at: string; dates: string[] }[],
): Promise<void> {
  const user = await dailyRuleUser(timezone, startDate);
  const clock = clockAt(steps[0]?.at ?? '2092-01-01T00:00:00Z');
  const jobs = recurringJobs([user], clock);
  for (const step of steps) {
    clock.moveTo(step.at);
    await jobs.generate();
    await jobs.generate();
    expect({ at: step.at, dates: await occurrenceDates(user.ruleId) }).toEqual({
      at: step.at,
      dates: step.dates,
    });
  }
}

describe('RF-M14-04 las ocurrencias se ejecutan a las 00:00 del usuario', { timeout: TEST_TIMEOUT_MS }, () => {
  it('RNF-20 en La Paz la ocurrencia del 15/06 aparece a las 04:00Z y una segunda corrida no la repite', async () => {
    await expectOccurrences(LA_PAZ, '2092-06-15', [
      { at: '2092-06-15T03:59:00Z', dates: [] },
      { at: '2092-06-15T04:00:00Z', dates: ['2092-06-15'] },
      { at: '2092-06-15T20:00:00Z', dates: ['2092-06-15'] },
      { at: '2092-06-16T04:00:00Z', dates: ['2092-06-15', '2092-06-16'] },
    ]);
  });

  it('RNF-20 en Madrid (verano) la ocurrencia del 15/06 aparece a las 22:00Z del día anterior', async () => {
    await expectOccurrences(MADRID, '2092-06-15', [
      { at: '2092-06-14T21:59:00Z', dates: [] },
      { at: '2092-06-14T22:00:00Z', dates: ['2092-06-15'] },
    ]);
  });

  it('RNF-20 en Santiago (verano) la ocurrencia del 15/01 aparece a las 03:00Z', async () => {
    await expectOccurrences(SANTIAGO, '2092-01-15', [
      { at: '2092-01-15T02:59:00Z', dates: [] },
      { at: '2092-01-15T03:00:00Z', dates: ['2092-01-15'] },
    ]);
  });

  it('RNF-20 con un mismo instante cada usuario genera según su día local', async () => {
    const batch = [
      await dailyRuleUser(LA_PAZ, '2092-01-15'),
      await dailyRuleUser(SANTIAGO, '2092-01-15'),
      await dailyRuleUser(MADRID, '2092-01-15'),
    ];

    // 03:30Z of the 15th: 23:30 of the 14th in La Paz, 00:30 of the 15th in Santiago and 04:30 in Madrid.
    await recurringJobs(batch, clockAt('2092-01-15T03:30:00Z')).generate();

    expect(await occurrenceDates(batch[0]?.ruleId ?? '')).toEqual([]);
    expect(await occurrenceDates(batch[1]?.ruleId ?? '')).toEqual(['2092-01-15']);
    expect(await occurrenceDates(batch[2]?.ruleId ?? '')).toEqual(['2092-01-15']);
  });

  it('RF-M14-04 en Madrid el 30/03, día del cambio de hora, el 00:00 existe y la ocurrencia sale a las 00:00 (23:00Z del 29/03)', async () => {
    await expectOccurrences(MADRID, '2092-03-30', [
      { at: '2092-03-29T22:59:00Z', dates: [] },
      { at: '2092-03-29T23:00:00Z', dates: ['2092-03-30'] },
      // The change at 01:00Z (02:00 -> 03:00) neither repeats nor skips the day.
      { at: '2092-03-30T01:00:00Z', dates: ['2092-03-30'] },
      { at: '2092-03-30T21:59:00Z', dates: ['2092-03-30'] },
      { at: '2092-03-30T22:00:00Z', dates: ['2092-03-30', '2092-03-31'] },
    ]);
  });

  it('RF-M14-04 en Madrid el 26/10, día de 25 horas, la ocurrencia del 27/10 sale a las 23:00Z y no una hora antes', async () => {
    await expectOccurrences(MADRID, '2092-10-25', [
      { at: '2092-10-24T22:00:00Z', dates: ['2092-10-25'] },
      { at: '2092-10-25T22:00:00Z', dates: ['2092-10-25', '2092-10-26'] },
      { at: '2092-10-26T01:30:00Z', dates: ['2092-10-25', '2092-10-26'] },
      { at: '2092-10-26T22:59:00Z', dates: ['2092-10-25', '2092-10-26'] },
      { at: '2092-10-26T23:00:00Z', dates: ['2092-10-25', '2092-10-26', '2092-10-27'] },
    ]);
  });

  it('RF-M14-04 en Santiago el 07/09, sin 00:00, la ocurrencia se ejecuta una vez en el primer minuto válido (01:00, 04:00Z)', async () => {
    const user = await dailyRuleUser(SANTIAGO, '2092-09-07');
    const clock = clockAt('2092-09-07T03:50:00Z');
    const jobs = recurringJobs([user], clock);
    let firstSeen: string | null = null;

    // The tick runs every minute: the occurrence appears at the first minute that exists.
    for (let minute = 0; minute <= 20; minute += 1) {
      const instant = new Date(Date.parse('2092-09-07T03:50:00Z') + minute * 60_000);
      clock.moveTo(instant.toISOString());
      await jobs.generate();
      if (firstSeen === null && (await occurrenceDates(user.ruleId)).length > 0) {
        firstSeen = instant.toISOString();
      }
    }

    expect(firstSeen).toBe('2092-09-07T04:00:00.000Z');
    expect(await occurrenceDates(user.ruleId)).toEqual(['2092-09-07']);
  });

  it('RF-M14-04 en Santiago el día del cambio no se pierde la ocurrencia del día anterior ni la del siguiente', async () => {
    await expectOccurrences(SANTIAGO, '2092-09-06', [
      { at: '2092-09-06T03:59:00Z', dates: [] },
      { at: '2092-09-06T04:00:00Z', dates: ['2092-09-06'] },
      { at: '2092-09-07T03:59:00Z', dates: ['2092-09-06'] },
      { at: '2092-09-07T04:00:00Z', dates: ['2092-09-06', '2092-09-07'] },
      { at: '2092-09-08T02:59:00Z', dates: ['2092-09-06', '2092-09-07'] },
      { at: '2092-09-08T03:00:00Z', dates: ['2092-09-06', '2092-09-07', '2092-09-08'] },
    ]);
  });

  it('RF-M14-04 si el sistema estuvo caído el día del cambio de hora en Santiago, al volver cada fecha sale una sola vez', async () => {
    await expectOccurrences(SANTIAGO, '2092-09-05', [
      { at: '2092-09-08T12:00:00Z', dates: ['2092-09-05', '2092-09-06', '2092-09-07', '2092-09-08'] },
    ]);
  });

  it('RF-M14-04 en Santiago el 06/04 la hora 23:00 se repite y la ocurrencia del 06/04 sale una sola vez, a las 04:00Z', async () => {
    await expectOccurrences(SANTIAGO, '2092-04-05', [
      { at: '2092-04-05T03:00:00Z', dates: ['2092-04-05'] },
      // 03:00Z: the clock goes from 24:00 back to 23:00 of the 5th, which is still the 5th.
      { at: '2092-04-06T02:59:00Z', dates: ['2092-04-05'] },
      { at: '2092-04-06T03:00:00Z', dates: ['2092-04-05'] },
      { at: '2092-04-06T03:59:00Z', dates: ['2092-04-05'] },
      { at: '2092-04-06T04:00:00Z', dates: ['2092-04-05', '2092-04-06'] },
      { at: '2092-04-06T12:00:00Z', dates: ['2092-04-05', '2092-04-06'] },
    ]);
  });

  it('RF-M14-04 un cambio de zona horaria no repite ni pierde fechas', async () => {
    const user = await dailyRuleUser(LA_PAZ, '2092-01-10');
    const clock = clockAt('2092-01-15T03:30:00Z');
    const jobs = recurringJobs([user], clock);
    const days = (from: number, to: number): string[] =>
      Array.from({ length: to - from + 1 }, (_, index) => `2092-01-${String(from + index).padStart(2, '0')}`);
    const changeTimezone = async (timezone: string): Promise<void> => {
      await prisma.$executeRaw`
        UPDATE auth_user SET timezone = ${timezone} WHERE id = ${user.userId}::uuid`;
    };

    // In La Paz it is 23:30 of the 14th.
    await jobs.generate();
    expect(await occurrenceDates(user.ruleId)).toEqual(days(10, 14));

    // In Madrid it is already the 15th: the new date is added once.
    await changeTimezone(MADRID);
    await jobs.generate();
    await jobs.generate();
    expect(await occurrenceDates(user.ruleId)).toEqual(days(10, 15));

    // Back in La Paz the 15th is still ahead: nothing is repeated or removed.
    await changeTimezone(LA_PAZ);
    await jobs.generate();
    expect(await occurrenceDates(user.ruleId)).toEqual(days(10, 15));

    // When the 15th arrives in La Paz it is not generated again, and the 16th comes in its turn.
    clock.moveTo('2092-01-15T04:00:00Z');
    await jobs.generate();
    expect(await occurrenceDates(user.ruleId)).toEqual(days(10, 15));
    clock.moveTo('2092-01-16T04:00:00Z');
    await jobs.generate();
    expect(await occurrenceDates(user.ruleId)).toEqual(days(10, 16));
  });
});

// ---------- notifications.scheduled ----------

interface NoticeUser {
  user: TestUser;
  debtId: string;
  dueDate: string;
}

/** A user with a debt that falls due on `dueDate`, the local day of the instants of the test. */
async function noticeUser(timezone: string, dueDate: string): Promise<NoticeUser> {
  const user = await newUser(timezone);
  const debt = await createDebt(user.id, { dueDate, startDate: '2090-01-01' });
  return { user, debtId: debt.id, dueDate };
}

function scheduledJob(users: NoticeUser[], clock: Clock) {
  const scheduled = users.map(({ user }) => ({ id: user.id, timezone: user.timezone }));
  return createScheduledNotifications({
    uow: container.uow,
    clock,
    release: '1.2',
    users: {
      all: () => Promise.resolve(scheduled),
      find: (userId) => Promise.resolve(scheduled.find((user) => user.id === userId) ?? null),
    },
  });
}

async function debtNoticeKeys(userId: string): Promise<string[]> {
  const rows = await prisma.$queryRaw<{ eventKey: string }[]>`
    SELECT event_key AS "eventKey" FROM notification
     WHERE user_id = ${userId}::uuid AND type = 'payment_upcoming'::notification_type
     ORDER BY event_key`;
  return rows.map((row) => row.eventKey);
}

/** The notice of the debt due today appears at 08:00 local and not a minute before. */
async function expectNoticeAt(
  timezone: string,
  dueDate: string,
  lastMinuteBefore: string,
  eight: string,
): Promise<void> {
  const spec = await noticeUser(timezone, dueDate);
  const clock = clockAt(lastMinuteBefore);
  const job = scheduledJob([spec], clock);

  await job.run();
  expect(await debtNoticeKeys(spec.user.id)).toEqual([]);

  clock.moveTo(eight);
  await job.run();
  await job.run();
  expect(await debtNoticeKeys(spec.user.id)).toEqual([`debt:${spec.debtId}:due:${dueDate}:d0`]);
}

describe('RNF-20 los avisos de las 08:00 usan la hora local del usuario', { timeout: TEST_TIMEOUT_MS }, () => {
  it('RNF-20 en La Paz el aviso del día aparece a las 08:00 (12:00Z)', async () => {
    await expectNoticeAt(LA_PAZ, '2092-06-15', '2092-06-15T11:59:00Z', '2092-06-15T12:00:00Z');
  });

  it('RNF-20 en Madrid (verano) el aviso del día aparece a las 08:00 (06:00Z)', async () => {
    await expectNoticeAt(MADRID, '2092-06-15', '2092-06-15T05:59:00Z', '2092-06-15T06:00:00Z');
  });

  it('RNF-20 en Madrid (invierno) el aviso del día aparece a las 08:00 (07:00Z)', async () => {
    await expectNoticeAt(MADRID, '2092-01-15', '2092-01-15T06:59:00Z', '2092-01-15T07:00:00Z');
  });

  it('RNF-20 en Santiago (verano) el aviso del día aparece a las 08:00 (11:00Z)', async () => {
    await expectNoticeAt(SANTIAGO, '2092-01-15', '2092-01-15T10:59:00Z', '2092-01-15T11:00:00Z');
  });

  it('RNF-20 en Santiago (invierno) el aviso del día aparece a las 08:00 (12:00Z)', async () => {
    await expectNoticeAt(SANTIAGO, '2092-06-15', '2092-06-15T11:59:00Z', '2092-06-15T12:00:00Z');
  });

  it('RNF-20 con un mismo instante a las 11:30Z solo reciben el aviso Santiago (08:30) y Madrid (12:30), no La Paz (07:30)', async () => {
    const batch = [
      await noticeUser(LA_PAZ, '2092-01-15'),
      await noticeUser(SANTIAGO, '2092-01-15'),
      await noticeUser(MADRID, '2092-01-15'),
    ];

    await scheduledJob(batch, clockAt('2092-01-15T11:30:00Z')).run();

    expect(await debtNoticeKeys(batch[0]?.user.id ?? '')).toEqual([]);
    expect(await debtNoticeKeys(batch[1]?.user.id ?? '')).toEqual([
      `debt:${batch[1]?.debtId ?? ''}:due:2092-01-15:d0`,
    ]);
    expect(await debtNoticeKeys(batch[2]?.user.id ?? '')).toEqual([
      `debt:${batch[2]?.debtId ?? ''}:due:2092-01-15:d0`,
    ]);
  });

  it('RNF-20 en Madrid el 30/03, día del cambio a verano, el aviso sale a las 08:00 de verano (06:00Z)', async () => {
    await expectNoticeAt(MADRID, '2092-03-30', '2092-03-30T05:59:00Z', '2092-03-30T06:00:00Z');
  });

  it('RNF-20 en Madrid el 26/10, día del cambio a invierno, el aviso sale a las 08:00 de invierno (07:00Z)', async () => {
    await expectNoticeAt(MADRID, '2092-10-26', '2092-10-26T06:59:00Z', '2092-10-26T07:00:00Z');
  });

  it('RNF-20 en Santiago el 07/09, día del cambio a verano, el aviso sale a las 08:00 (11:00Z)', async () => {
    await expectNoticeAt(SANTIAGO, '2092-09-07', '2092-09-07T10:59:00Z', '2092-09-07T11:00:00Z');
  });

  it('RNF-20 en Santiago el 06/04, día del cambio a invierno, el aviso sale a las 08:00 (12:00Z)', async () => {
    await expectNoticeAt(SANTIAGO, '2092-04-06', '2092-04-06T11:59:00Z', '2092-04-06T12:00:00Z');
  });

  it('RNF-20 una deuda que vence el 16/06 no genera el aviso del día mientras en la zona del usuario sea el 15/06, aunque en UTC ya sea el 16/06', async () => {
    const spec = await noticeUser(LA_PAZ, '2092-06-16');
    // 02:30Z of the 16th is 22:30 of the 15th in La Paz: the debt falls due tomorrow, not today.
    const job = scheduledJob([spec], clockAt('2092-06-16T02:30:00Z'));

    await job.run();

    expect(await debtNoticeKeys(spec.user.id)).toEqual([]);
  });
});
