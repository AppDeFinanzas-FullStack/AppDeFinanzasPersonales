import { todayFor } from '@finanzas/domain';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { Clock } from '../../src/application/ports/clock.js';
import type { UnitOfWork } from '../../src/application/ports/unit-of-work.js';
import type { RecurringGenerator } from '../../src/application/shared/recurring-generator.js';
import { buildContainer, type Container } from '../../src/composition/container.js';
import { parseEnv } from '../../src/infrastructure/config/env.js';
import { createAccount } from '../factories/account.factory.js';
import { deleteGoalsOf } from '../factories/goal.factory.js';
import { deleteLedgerOf } from '../factories/ledger.factory.js';
import {
  createOccurrence,
  createRule,
  deleteRecurringOf,
  occurrencesOf,
  occurrenceStatus,
} from '../factories/recurring.factory.js';
import { createUser, deleteCreatedUsers } from '../factories/user.factory.js';
import { disconnectTestPrisma, testPrisma } from './setup/db.js';

/**
 * The task fixes the job `recurring.expirePending` in `application/jobs/recurring.ts` (plan
 * §4.14.3), but not its signature. These tests assume:
 * - `createRecurringJobs(deps)` keeps the deps of TASK-226 (`uow`, `generator`, `users`, `clock`)
 *   and the jobs it returns gain `expirePending()`, which runs `recurring.expirePending` for the
 *   users that `deps.users` lists, each under its lock (ADR-01), with "now" taken from
 *   `deps.clock.now()`. How `deps.users` lists the users with expired pendings is not fixed, so the
 *   `users` of these tests answers every listing method with the users of the test.
 * - `container.ts` registers `recurring.expirePending` in `jobs.registerJob` with its `forUser`, so
 *   `container.jobs.catchUpUser(userId)` and `container.jobs.tick()` run it; the users it walks
 *   include those whose pendings belong to paused or finished rules.
 * - A pending occurrence whose `pending_since` is more than 30 days before "now" becomes `omitted`,
 *   with a notice of type `recurring_pending` and key `recurring_omitted:{occurrenceId}`, and the
 *   original notice `recurring_pending:{occurrenceId}` gets the decision status `resolved`.
 *
 * The jobs are built here with the `uow` and `recurringGenerator` of the container built with
 * `RELEASE=1.2`, a fixed clock, and a `users` that only lists the users of this file. Pending
 * occurrences come from the generator of TASK-226 (rules in confirm mode) or straight by SQL with the
 * factory; results are read straight by SQL.
 */
interface RecurringJobsUnderTest {
  generate(): Promise<void>;
  expirePending(): Promise<void>;
}
interface CreateRecurringJobsUsers {
  withActiveRules(): Promise<string[]>;
  timezoneOf(userId: string): Promise<string | null>;
}
type CreateRecurringJobs = (deps: {
  uow: UnitOfWork;
  generator: RecurringGenerator;
  users: CreateRecurringJobsUsers;
  clock: Clock;
}) => RecurringJobsUnderTest;

const { createRecurringJobs } =
  (await import('../../src/application/jobs/recurring.js')) as unknown as {
    createRecurringJobs: CreateRecurringJobs;
  };

const envSource = (): Record<string, string> => ({
  NODE_ENV: 'test',
  PORT: '3000',
  DATABASE_URL: process.env['TEST_DATABASE_URL'] ?? '',
  AUTH_SECRET: 'auth-secret-value-0123456789abcdef0123456789',
  HMAC_SECRET: 'hmac-secret-value-0123456789abcdef0123456789',
  JOBS_SECRET: 'jobs-secret-value-0123456789abcdef0123456789',
  RESEND_API_KEY: 're_resend-key-value-0123456789',
  RELEASE: '1.2',
  WEB_ORIGIN: 'http://localhost:5173',
  INTEGRATIONS: 'fake',
});

const prisma = testPrisma();
const TZ = 'America/La_Paz';
const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;

let container: Container;
const usedUserIds: string[] = [];

beforeAll(async () => {
  container = await Promise.resolve(buildContainer(parseEnv(envSource())));
});

afterAll(async () => {
  await deleteRecurringOf(usedUserIds);
  await deleteGoalsOf(usedUserIds);
  await deleteLedgerOf(usedUserIds);
  await deleteCreatedUsers();
  await container.prisma.$disconnect();
  await disconnectTestPrisma();
});

// ---------- Helpers ----------

async function newUserId(): Promise<string> {
  const user = await createUser({ timezone: TZ });
  usedUserIds.push(user.id);
  return user.id;
}

const fixedClock = (now: Date): Clock => ({
  now: () => now,
  todayFor: (timezone) => todayFor(timezone, now),
});

/** The recurring jobs over the users given, with "now" fixed at that instant. */
function jobsAt(now: Date, userIds: string[]): RecurringJobsUnderTest {
  return createRecurringJobs({
    uow: container.uow,
    generator: container.recurringGenerator,
    users: usersListing(userIds),
    clock: fixedClock(now),
  });
}

/** A `users` dep whose every listing method answers the users given, and whose zone is `TZ`. */
function usersListing(userIds: string[]): CreateRecurringJobsUsers {
  const base: CreateRecurringJobsUsers = {
    withActiveRules: () => Promise.resolve([...userIds]),
    timezoneOf: () => Promise.resolve(TZ),
  };
  return new Proxy(base, {
    get(target, property, receiver) {
      if (property in target || typeof property === 'symbol' || property === 'then') {
        return Reflect.get(target, property, receiver) as unknown;
      }
      return () => Promise.resolve([...userIds]);
    },
  });
}

function addDays(date: string, days: number): string {
  return new Date(Date.parse(`${date}T00:00:00Z`) + days * DAY_MS).toISOString().slice(0, 10);
}

/** A rule in confirm mode and the pending occurrence the generator leaves for it today. */
async function generatedPending(userId: string): Promise<{ ruleId: string; occurrenceId: string }> {
  const today = todayFor(TZ, new Date());
  const account = await createAccount(userId, { initialBalanceDate: '2020-01-01' });
  const rule = await createRule(userId, {
    amount: null,
    accountId: account.id,
    mode: 'confirm',
    dayOfMonth: Number(today.slice(8, 10)),
    startDate: today,
  });
  await container.uow.run(
    async (repos) => {
      const locked = await repos.recurringRules.lockForUpdate(rule.id);
      if (locked === null) {
        throw new Error('The rule does not exist');
      }
      await container.recurringGenerator.generateDue(repos, userId, locked, today);
    },
    { userLock: userId },
  );
  const occurrences = await occurrencesOf(rule.id);
  const occurrence = occurrences[0];
  if (occurrences.length !== 1 || occurrence?.status !== 'pending') {
    throw new Error('The generator was expected to leave one pending occurrence');
  }
  return { ruleId: rule.id, occurrenceId: occurrence.id };
}

interface StoredNotice {
  type: string;
  eventKey: string;
  decisionStatus: string | null;
}

async function noticesOf(userId: string): Promise<StoredNotice[]> {
  return prisma.$queryRaw<StoredNotice[]>`
    SELECT type::text AS type, event_key AS "eventKey", decision_status::text AS "decisionStatus"
      FROM notification WHERE user_id = ${userId}::uuid
     ORDER BY event_key`;
}

async function omittedNotices(userId: string, occurrenceId: string): Promise<StoredNotice[]> {
  return (await noticesOf(userId)).filter(
    (notice) => notice.eventKey === `recurring_omitted:${occurrenceId}`,
  );
}

async function originalNoticeStatus(
  userId: string,
  occurrenceId: string,
): Promise<string | null | undefined> {
  return (await noticesOf(userId)).find(
    (notice) => notice.eventKey === `recurring_pending:${occurrenceId}`,
  )?.decisionStatus;
}

// ---------- Pendiente vence ----------

describe('recurring.expirePending: pendiente vence', () => {
  it('RF-M14-07 Pendiente vence: con un reloj 30 días después el pendiente pasa a Omitido y se genera un aviso', async () => {
    const userId = await newUserId();
    const { occurrenceId } = await generatedPending(userId);

    await jobsAt(new Date(Date.now() + 30 * DAY_MS + HOUR_MS), [userId]).expirePending();

    expect(await occurrenceStatus(occurrenceId)).toBe('omitted');
    expect(await omittedNotices(userId, occurrenceId)).toEqual([
      expect.objectContaining({
        type: 'recurring_pending',
        eventKey: `recurring_omitted:${occurrenceId}`,
      }),
    ]);
  });

  it('RF-M14-07 al vencer, el aviso original del pendiente queda resuelto', async () => {
    const userId = await newUserId();
    const { occurrenceId } = await generatedPending(userId);
    expect(await originalNoticeStatus(userId, occurrenceId)).toBe('waiting');

    await jobsAt(new Date(Date.now() + 30 * DAY_MS + HOUR_MS), [userId]).expirePending();

    expect(await originalNoticeStatus(userId, occurrenceId)).toBe('resolved');
  });

  it('RF-M14-07 un pendiente de menos de 30 días sigue pendiente y no genera aviso de omitido', async () => {
    const userId = await newUserId();
    const { occurrenceId } = await generatedPending(userId);

    await jobsAt(new Date(Date.now() + 29 * DAY_MS), [userId]).expirePending();

    expect(await occurrenceStatus(occurrenceId)).toBe('pending');
    expect(await omittedNotices(userId, occurrenceId)).toEqual([]);
    expect(await originalNoticeStatus(userId, occurrenceId)).toBe('waiting');
  });

  it('RF-M14-07 las ocurrencias ya decididas no se tocan', async () => {
    const userId = await newUserId();
    const account = await createAccount(userId);
    const rule = await createRule(userId, { accountId: account.id });
    const skipped = await createOccurrence(userId, rule.id, { status: 'skipped' });
    const registered = await createOccurrence(userId, rule.id, { status: 'registered' });

    await jobsAt(new Date(Date.now() + 60 * DAY_MS), [userId]).expirePending();

    expect(await occurrenceStatus(skipped.id)).toBe('skipped');
    expect(await occurrenceStatus(registered.id)).toBe('registered');
    expect(await noticesOf(userId)).toEqual([]);
  });

  it('RF-M14-07 correr el job dos veces deja un solo aviso de omitido', async () => {
    const userId = await newUserId();
    const { occurrenceId } = await generatedPending(userId);
    const jobs = jobsAt(new Date(Date.now() + 31 * DAY_MS), [userId]);

    await jobs.expirePending();
    await jobs.expirePending();

    expect(await occurrenceStatus(occurrenceId)).toBe('omitted');
    expect(await omittedNotices(userId, occurrenceId)).toHaveLength(1);
  });

  it('RF-M14-07 las ocurrencias siguientes se generan aunque haya pendientes anteriores', async () => {
    const userId = await newUserId();
    const today = todayFor(TZ, new Date());
    const account = await createAccount(userId, { initialBalanceDate: '2020-01-01' });
    const rule = await createRule(userId, {
      amount: null,
      accountId: account.id,
      mode: 'confirm',
      dayOfMonth: Number(today.slice(8, 10)),
      startDate: today,
    });
    const old = await createOccurrence(userId, rule.id, {
      scheduledDate: addDays(today, -40),
      pendingSince: new Date(Date.now() - 40 * DAY_MS),
    });

    await jobsAt(new Date(), [userId]).generate();

    const occurrences = await occurrencesOf(rule.id);
    expect(occurrences.map((row) => [row.scheduledDate, row.status])).toContainEqual([
      today,
      'pending',
    ]);
    expect(await occurrenceStatus(old.id)).toBe('pending');
  });
});

// ---------- Pendientes recuperados tras una caída ----------

describe('recurring.expirePending: pendientes recuperados tras una caída', () => {
  it('RNF-13 un pendiente recuperado tras una caída cuenta los 30 días desde pending_since y no desde su fecha', async () => {
    const userId = await newUserId();
    const today = todayFor(TZ, new Date());
    const account = await createAccount(userId);
    const rule = await createRule(userId, { accountId: account.id, mode: 'confirm', amount: null });
    // Scheduled 45 days ago, but generated in the catch-up after the outage only 10 days ago.
    const recovered = await createOccurrence(userId, rule.id, {
      scheduledDate: addDays(today, -45),
      pendingSince: new Date(Date.now() - 10 * DAY_MS),
    });

    await jobsAt(new Date(), [userId]).expirePending();

    expect(await occurrenceStatus(recovered.id)).toBe('pending');
    expect(await omittedNotices(userId, recovered.id)).toEqual([]);

    await jobsAt(new Date(Date.now() + 20 * DAY_MS + HOUR_MS), [userId]).expirePending();

    expect(await occurrenceStatus(recovered.id)).toBe('omitted');
    expect(await omittedNotices(userId, recovered.id)).toHaveLength(1);
  });

  it('RNF-13 un pendiente que lleva más de 30 días desde pending_since vence en la primera corrida tras la caída', async () => {
    const userId = await newUserId();
    const account = await createAccount(userId);
    const rule = await createRule(userId, { accountId: account.id, mode: 'confirm', amount: null });
    const stale = await createOccurrence(userId, rule.id, {
      pendingSince: new Date(Date.now() - 31 * DAY_MS),
    });
    const fresh = await createOccurrence(userId, rule.id, {
      pendingSince: new Date(Date.now() - 29 * DAY_MS),
    });

    await jobsAt(new Date(), [userId]).expirePending();

    expect(await occurrenceStatus(stale.id)).toBe('omitted');
    expect(await occurrenceStatus(fresh.id)).toBe('pending');
    expect(await omittedNotices(userId, stale.id)).toHaveLength(1);
    expect(await omittedNotices(userId, fresh.id)).toEqual([]);
  });

  it('RNF-13 una corrida para varios usuarios vence los pendientes de cada uno', async () => {
    const first = await newUserId();
    const second = await newUserId();
    const expired: { userId: string; occurrenceId: string }[] = [];
    for (const userId of [first, second]) {
      const account = await createAccount(userId);
      const rule = await createRule(userId, {
        accountId: account.id,
        mode: 'confirm',
        amount: null,
      });
      const occurrence = await createOccurrence(userId, rule.id, {
        pendingSince: new Date(Date.now() - 35 * DAY_MS),
      });
      expired.push({ userId, occurrenceId: occurrence.id });
    }

    await jobsAt(new Date(), [first, second]).expirePending();

    for (const { userId, occurrenceId } of expired) {
      expect(await occurrenceStatus(occurrenceId)).toBe('omitted');
      expect(await omittedNotices(userId, occurrenceId)).toHaveLength(1);
    }
  });
});

// ---------- Registro en el contenedor ----------

describe('recurring.expirePending registrado en el contenedor', () => {
  it('RF-M14-07 catchUpUser corre recurring.expirePending y vence el pendiente de una regla pausada', async () => {
    const userId = await newUserId();
    const account = await createAccount(userId);
    const rule = await createRule(userId, {
      accountId: account.id,
      mode: 'confirm',
      amount: null,
      status: 'paused',
    });
    const occurrence = await createOccurrence(userId, rule.id, {
      pendingSince: new Date(Date.now() - 31 * DAY_MS),
    });

    await container.jobs.catchUpUser(userId);

    expect(await occurrenceStatus(occurrence.id)).toBe('omitted');
    expect(await omittedNotices(userId, occurrence.id)).toEqual([
      expect.objectContaining({ type: 'recurring_pending' }),
    ]);
  });

  it('RF-M14-07 el tick vence los pendientes de usuarios cuyas reglas están pausadas o terminadas', async () => {
    const paused = await newUserId();
    const finished = await newUserId();
    const expired: { userId: string; occurrenceId: string }[] = [];
    for (const [userId, status] of [
      [paused, 'paused'],
      [finished, 'finished'],
    ] as const) {
      const account = await createAccount(userId);
      const rule = await createRule(userId, {
        accountId: account.id,
        mode: 'confirm',
        amount: null,
        status,
      });
      const occurrence = await createOccurrence(userId, rule.id, {
        pendingSince: new Date(Date.now() - 32 * DAY_MS),
      });
      expired.push({ userId, occurrenceId: occurrence.id });
    }
    await prisma.$executeRaw`DELETE FROM job_run WHERE job IN ('recurring.generate', 'recurring.expirePending')`;

    try {
      await container.jobs.tick();
    } finally {
      await prisma.$executeRaw`DELETE FROM job_run WHERE job IN ('recurring.generate', 'recurring.expirePending')`;
    }

    for (const { userId, occurrenceId } of expired) {
      expect(await occurrenceStatus(occurrenceId)).toBe('omitted');
      expect(await omittedNotices(userId, occurrenceId)).toHaveLength(1);
    }
  });
});
