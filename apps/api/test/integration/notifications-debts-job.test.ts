import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createScheduledNotifications } from '../../src/application/jobs/notifications.js';
import type { Clock } from '../../src/application/ports/clock.js';
import type { UnitOfWork } from '../../src/application/ports/unit-of-work.js';
import { buildContainer, type Container } from '../../src/composition/container.js';
import { parseEnv } from '../../src/infrastructure/config/env.js';
import { createDebt } from '../factories/debt.factory.js';
import { createUser, deleteCreatedUsers, type TestUser } from '../factories/user.factory.js';
import { disconnectTestPrisma, testDatabaseUrl, testPrisma } from './setup/db.js';

/**
 * The plan fixes the job `notifications.scheduled` (plan §4.0, §4.15.3): it walks the users whose
 * local time already passed 08:00 (RF-M15-09) and creates today's debt due notices of their active
 * debts, in both directions, with the key `debt:{id}:due:{dueDate}:{d-3|d0|d+1}` (plan §4.13.3).
 * It does not fix how `application/jobs/notifications.ts` is built. These tests assume:
 * - It exports `createScheduledNotifications({ uow, clock, release, users })`, which returns
 *   `{ run(): Promise<void>; forUser(userId: string): Promise<void> }`: `run` is the handler of the
 *   tick and `forUser` its per-user scope for `catchUpUser` (ADR-01).
 * - `users` is the port that gives the users with their timezone (`ScheduledUser = { id, timezone }`):
 *   `all()` for the batch run and `find(userId)` (`null` when there is none) for `forUser`. The job
 *   itself decides, with `clock`, whether the local time of each user already passed 08:00.
 * - The notices are `payment_upcoming` notifications; their `params` carry the data of the i18n
 *   text "Vence en 3 días: debes Bs 1.200,00 a Juan": the person, the amount as decimal text
 *   (ADR-03) and the direction of the debt (`i_owe` | `owed_to_me`).
 * - The container registers the job as `notifications.scheduled` in `container.jobs`.
 */
const envSource = (): Record<string, string> => ({
  NODE_ENV: 'test',
  PORT: '3000',
  DATABASE_URL: testDatabaseUrl(),
  AUTH_SECRET: 'auth-secret-for-the-notifications-debts-job-test',
  HMAC_SECRET: 'hmac-secret-for-the-notifications-debts-job-test',
  JOBS_SECRET: 'jobs-secret-for-the-notifications-debts-job-test',
  RESEND_API_KEY: 'resend-key-for-the-notifications-debts-job-test',
  RELEASE: '1.1',
  WEB_ORIGIN: 'http://localhost:5173',
  INTEGRATIONS: 'fake',
});

let container: Container;
let uow: UnitOfWork;

beforeAll(async () => {
  container = await Promise.resolve(buildContainer(parseEnv(envSource())));
  uow = container.uow;
});

afterAll(async () => {
  await deleteCreatedUsers();
  await container.prisma.$disconnect();
  await disconnectTestPrisma();
});

// ---------- Helpers ----------

const LA_PAZ = 'America/La_Paz'; // UTC-4, no daylight saving.
const DUE = '2090-10-20';

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

/** A user the job walks, with the timezone of their profile (RNF-20). */
interface ScheduledUser {
  id: string;
  timezone: string;
}

/** The two handlers of the job: the tick's batch run and the per-user scope of `catchUpUser`. */
interface ScheduledJob {
  run(): Promise<void>;
  forUser(userId: string): Promise<void>;
}

function usersPort(users: TestUser[]) {
  const scheduled: ScheduledUser[] = users.map((user) => ({
    id: user.id,
    timezone: user.timezone,
  }));
  return {
    all: () => Promise.resolve(scheduled),
    find: (userId: string) => Promise.resolve(scheduled.find((user) => user.id === userId) ?? null),
  };
}

function jobAt(instant: Date, users: TestUser[]): ScheduledJob {
  return createScheduledNotifications({
    uow,
    clock: clockAt(instant),
    release: '1.1',
    users: usersPort(users),
  });
}

/** Runs the batch handler of the job at that instant, over those users. */
async function runAt(instant: Date, users: TestUser[]): Promise<void> {
  await jobAt(instant, users).run();
}

interface NotificationRow {
  type: string;
  eventKey: string;
  params: unknown;
  targetRoute: string;
}

const notificationsOf = (userId: string) =>
  testPrisma().$queryRaw<NotificationRow[]>`
    SELECT type::text AS type, event_key AS "eventKey", params, target_route AS "targetRoute"
      FROM notification WHERE user_id = ${userId}::uuid ORDER BY event_key`;

async function keysOf(userId: string): Promise<string[]> {
  const rows = await notificationsOf(userId);
  return rows.map((row) => row.eventKey).sort();
}

const key = (debtId: string, due: string, kind: 'd-3' | 'd0' | 'd+1') =>
  `debt:${debtId}:due:${due}:${kind}`;

/** Every string value of the params, at any depth. */
function stringValues(value: unknown): string[] {
  if (typeof value === 'string') return [value];
  if (typeof value === 'number') return [String(value)];
  if (Array.isArray(value)) return value.flatMap(stringValues);
  if (value !== null && typeof value === 'object') {
    return Object.values(value as Record<string, unknown>).flatMap(stringValues);
  }
  return [];
}

const newUser = (timezone: string = LA_PAZ) => createUser({ timezone });

// ---------- Tests ----------

describe('notifications.scheduled: vencimientos de deudas', () => {
  it('RF-M13-14 Aviso de vencimiento de deuda: el 17/10 a las 08:00 llega "Vence en 3 días: debes Bs 1.200,00 a Juan"', async () => {
    const user = await newUser();
    const debt = await createDebt(user.id, {
      direction: 'i_owe',
      person: 'Juan',
      principal: '1200.00',
      currencyCode: 'BOB',
      dueDate: DUE,
    });

    await runAt(laPaz('2090-10-17', '08:00'), [user]);

    const rows = await notificationsOf(user.id);
    expect(rows).toHaveLength(1);
    const [notice] = rows;
    expect(notice?.type).toBe('payment_upcoming');
    expect(notice?.eventKey).toBe(key(debt.id, DUE, 'd-3'));
    const values = stringValues(notice?.params);
    expect(values).toContain('Juan');
    expect(values).toContain('1200.00');
    expect(values).toContain('i_owe');
  });

  it('RF-M13-14 el día del vencimiento llega el aviso d0', async () => {
    const user = await newUser();
    const debt = await createDebt(user.id, { principal: '1200.00', dueDate: DUE });

    await runAt(laPaz(DUE, '09:00'), [user]);

    expect(await keysOf(user.id)).toEqual([key(debt.id, DUE, 'd0')]);
  });

  it('RF-M13-14 el día siguiente llega el aviso d+1 si la deuda quedó vencida', async () => {
    const user = await newUser();
    const debt = await createDebt(user.id, { principal: '1200.00', dueDate: DUE });

    await runAt(laPaz('2090-10-21', '08:30'), [user]);

    expect(await keysOf(user.id)).toEqual([key(debt.id, DUE, 'd+1')]);
  });

  it('RF-M13-14 después del día siguiente no hay más avisos', async () => {
    const user = await newUser();
    await createDebt(user.id, { principal: '1200.00', dueDate: DUE });

    for (const day of ['2090-10-22', '2090-10-23', '2090-10-27', '2090-11-20']) {
      await runAt(laPaz(day, '10:00'), [user]);
    }

    expect(await keysOf(user.id)).toEqual([]);
  });

  it('RF-M13-14 los días que no son d-3, d0 ni d+1 no generan avisos', async () => {
    const user = await newUser();
    await createDebt(user.id, { principal: '1200.00', dueDate: DUE });

    for (const day of ['2090-10-10', '2090-10-16', '2090-10-18', '2090-10-19']) {
      await runAt(laPaz(day, '10:00'), [user]);
    }

    expect(await keysOf(user.id)).toEqual([]);
  });

  it('RF-M13-14 una corrida diaria del 16/10 al 25/10 deja exactamente d-3, d0 y d+1', async () => {
    const user = await newUser();
    const debt = await createDebt(user.id, { principal: '1200.00', dueDate: DUE });

    for (let day = 16; day <= 25; day += 1) {
      await runAt(laPaz(`2090-10-${String(day)}`, '08:00'), [user]);
    }

    expect(await keysOf(user.id)).toEqual(
      [key(debt.id, DUE, 'd+1'), key(debt.id, DUE, 'd-3'), key(debt.id, DUE, 'd0')].sort(),
    );
  });

  it('RF-M13-14 los avisos llegan también en la dirección "Me deben"', async () => {
    const user = await newUser();
    const debt = await createDebt(user.id, {
      direction: 'owed_to_me',
      person: 'Ana',
      principal: '500.00',
      dueDate: DUE,
    });

    await runAt(laPaz('2090-10-17', '08:00'), [user]);

    const rows = await notificationsOf(user.id);
    expect(rows.map((row) => row.eventKey)).toEqual([key(debt.id, DUE, 'd-3')]);
    expect(rows[0]?.type).toBe('payment_upcoming');
    const values = stringValues(rows[0]?.params);
    expect(values).toContain('Ana');
    expect(values).toContain('500.00');
    expect(values).toContain('owed_to_me');
  });

  it('RF-M13-14 las deudas pagadas, condonadas o sin fecha límite no generan avisos', async () => {
    const user = await newUser();
    await createDebt(user.id, {
      status: 'paid',
      capitalOutstanding: '0',
      dueDate: DUE,
    });
    await createDebt(user.id, { status: 'forgiven', dueDate: DUE });
    await createDebt(user.id, { dueDate: null });

    await runAt(laPaz('2090-10-17', '08:00'), [user]);
    await runAt(laPaz(DUE, '08:00'), [user]);
    await runAt(laPaz('2090-10-21', '08:00'), [user]);

    expect(await keysOf(user.id)).toEqual([]);
  });

  it('RF-M13-14 una deuda pagada no recibe el aviso d+1 porque no quedó vencida', async () => {
    const user = await newUser();
    await createDebt(user.id, {
      status: 'paid',
      capitalOutstanding: '0',
      interestUnpaid: '0',
      dueDate: DUE,
    });

    await runAt(laPaz('2090-10-21', '08:00'), [user]);

    expect(await keysOf(user.id)).toEqual([]);
  });

  it('RNF-12 correr el job dos veces deja un solo aviso', async () => {
    const user = await newUser();
    const debt = await createDebt(user.id, { principal: '1200.00', dueDate: DUE });

    await runAt(laPaz('2090-10-17', '08:00'), [user]);
    await runAt(laPaz('2090-10-17', '15:00'), [user]);

    expect(await keysOf(user.id)).toEqual([key(debt.id, DUE, 'd-3')]);
  });

  it('RNF-12 la corrida del tick y la puesta al día del usuario el mismo día dejan un solo aviso', async () => {
    const user = await newUser();
    const debt = await createDebt(user.id, { principal: '1200.00', dueDate: DUE });
    const job = jobAt(laPaz('2090-10-17', '09:00'), [user]);

    await Promise.all([job.run(), job.forUser(user.id)]);
    await job.forUser(user.id);

    expect(await keysOf(user.id)).toEqual([key(debt.id, DUE, 'd-3')]);
  });

  it('RF-M15-09 a las 07:59 locales no se genera nada', async () => {
    const user = await newUser();
    await createDebt(user.id, { principal: '1200.00', dueDate: DUE });

    await runAt(laPaz('2090-10-17', '07:59'), [user]);
    await jobAt(laPaz('2090-10-17', '07:59'), [user]).forUser(user.id);

    expect(await keysOf(user.id)).toEqual([]);
  });

  it('RF-M15-09 a las 08:00 locales se genera el aviso del día', async () => {
    const user = await newUser();
    const debt = await createDebt(user.id, { principal: '1200.00', dueDate: DUE });

    await runAt(laPaz('2090-10-17', '07:59'), [user]);
    expect(await keysOf(user.id)).toEqual([]);

    await runAt(laPaz('2090-10-17', '08:00'), [user]);
    expect(await keysOf(user.id)).toEqual([key(debt.id, DUE, 'd-3')]);
  });

  it('RF-M15-09 la puesta al día del usuario antes de las 08:00 locales no genera nada y después sí', async () => {
    const user = await newUser();
    const debt = await createDebt(user.id, { principal: '1200.00', dueDate: DUE });

    await jobAt(laPaz(DUE, '06:00'), [user]).forUser(user.id);
    expect(await keysOf(user.id)).toEqual([]);

    await jobAt(laPaz(DUE, '08:01'), [user]).forUser(user.id);
    expect(await keysOf(user.id)).toEqual([key(debt.id, DUE, 'd0')]);
  });

  it('RNF-20 el día y la hora de los avisos se calculan en la zona horaria de cada usuario', async () => {
    const tokyo = await newUser('Asia/Tokyo'); // UTC+9
    const laPazUser = await newUser(LA_PAZ);
    const tokyoDebt = await createDebt(tokyo.id, { principal: '1200.00', dueDate: DUE });
    await createDebt(laPazUser.id, { principal: '1200.00', dueDate: DUE });

    // 17/10 08:30 in Tokyo (d-3 of 20/10); still 16/10 19:30 in La Paz (d-4) and 16/10 in UTC.
    await runAt(new Date('2090-10-16T23:30:00Z'), [tokyo, laPazUser]);

    expect(await keysOf(tokyo.id)).toEqual([key(tokyoDebt.id, DUE, 'd-3')]);
    expect(await keysOf(laPazUser.id)).toEqual([]);
  });

  it('RNF-20 un usuario cuya hora local todavía no llega a las 08:00 no recibe avisos aunque en UTC ya sea su día', async () => {
    const user = await newUser(LA_PAZ);
    await createDebt(user.id, { principal: '1200.00', dueDate: DUE });

    // 17/10 03:00 in UTC, but 16/10 23:00 in La Paz: no notice of 17/10 yet.
    await runAt(new Date('2090-10-17T03:00:00Z'), [user]);
    // 17/10 06:00 in La Paz (10:00 UTC): its local time has not reached 08:00.
    await runAt(new Date('2090-10-17T10:00:00Z'), [user]);

    expect(await keysOf(user.id)).toEqual([]);
  });

  it('TASK-215 cada usuario recibe solo los avisos de sus propias deudas', async () => {
    const owner = await newUser();
    const other = await newUser();
    const ownDebt = await createDebt(owner.id, { principal: '1200.00', dueDate: DUE });
    const otherDebt = await createDebt(other.id, { principal: '300.00', dueDate: DUE });

    await runAt(laPaz('2090-10-17', '08:00'), [owner, other]);
    await jobAt(laPaz(DUE, '08:00'), [owner, other]).forUser(owner.id);

    expect(await keysOf(owner.id)).toEqual(
      [key(ownDebt.id, DUE, 'd-3'), key(ownDebt.id, DUE, 'd0')].sort(),
    );
    expect(await keysOf(other.id)).toEqual([key(otherDebt.id, DUE, 'd-3')]);
  });

  it('TASK-215 el contenedor registra notifications.scheduled en container.jobs', () => {
    expect(() => {
      container.jobs.registerJob('notifications.scheduled', () => Promise.resolve());
    }).toThrow();
  });
});
