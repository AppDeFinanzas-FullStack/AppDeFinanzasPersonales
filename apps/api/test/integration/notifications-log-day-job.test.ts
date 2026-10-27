import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createScheduledNotifications } from '../../src/application/jobs/notifications.js';
import type { Clock } from '../../src/application/ports/clock.js';
import type { UnitOfWork } from '../../src/application/ports/unit-of-work.js';
import { buildContainer, type Container } from '../../src/composition/container.js';
import { parseEnv } from '../../src/infrastructure/config/env.js';
import { createAccount } from '../factories/account.factory.js';
import { createLedgerTransaction, deleteLedgerOf } from '../factories/ledger.factory.js';
import { createUser, deleteCreatedUsers, type TestUser } from '../factories/user.factory.js';
import { disconnectTestPrisma, testDatabaseUrl, testPrisma } from './setup/db.js';

/**
 * TASK-239 extends the job `notifications.scheduled` (plan §4.15.3) with the `log_day` notice of
 * RF-M15-02: with the type active (off by default), at its hour (21:00 by default) and on the
 * weekdays the user chose (0 = Sunday), it creates one notice per day with the key
 * `log_day:{fecha}`, the local date of the user. It is generated even if the user already
 * registered movements that day (EC-M15-03).
 *
 * These tests reuse the interface of the job fixed by TASK-215:
 * `createScheduledNotifications({ uow, clock, release, users })` returns `{ run, forUser }`.
 */
const envSource = (): Record<string, string> => ({
  NODE_ENV: 'test',
  PORT: '3000',
  DATABASE_URL: testDatabaseUrl(),
  AUTH_SECRET: 'auth-secret-for-the-notifications-log-day-job-test',
  HMAC_SECRET: 'hmac-secret-for-the-notifications-log-day-job-test',
  JOBS_SECRET: 'jobs-secret-for-the-notifications-log-day-job-test',
  RESEND_API_KEY: 'resend-key-for-the-notifications-log-day-job-test',
  RELEASE: '1.2',
  WEB_ORIGIN: 'http://localhost:5173',
  INTEGRATIONS: 'fake',
});

let container: Container;
let uow: UnitOfWork;
const userIds: string[] = [];

beforeAll(async () => {
  container = await Promise.resolve(buildContainer(parseEnv(envSource())));
  uow = container.uow;
});

afterAll(async () => {
  await deleteLedgerOf(userIds);
  await deleteCreatedUsers();
  await container.prisma.$disconnect();
  await disconnectTestPrisma();
});

// ---------- Helpers ----------

const LA_PAZ = 'America/La_Paz'; // UTC-4, no daylight saving.

/** The instant of that local time in La Paz (UTC-4). */
const laPaz = (date: string, time = '21:00'): Date => new Date(`${date}T${time}:00-04:00`);

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

type Release = '1.0' | '1.1' | '1.2';

function usersPort(users: TestUser[]) {
  const scheduled = users.map((user) => ({ id: user.id, timezone: user.timezone }));
  return {
    all: () => Promise.resolve(scheduled),
    find: (userId: string) => Promise.resolve(scheduled.find((user) => user.id === userId) ?? null),
  };
}

function jobAt(instant: Date, users: TestUser[], release: Release = '1.2') {
  return createScheduledNotifications({
    uow,
    clock: clockAt(instant),
    release,
    users: usersPort(users),
  });
}

/** Runs the batch handler of the job at that instant, over those users. */
async function runAt(instant: Date, users: TestUser[], release: Release = '1.2'): Promise<void> {
  await jobAt(instant, users, release).run();
}

/** Every day from `from` to `to`, both included, as `YYYY-MM-DD`. */
function daysFrom(from: string, to: string): string[] {
  const days: string[] = [];
  for (
    let instant = Date.parse(`${from}T00:00:00Z`);
    instant <= Date.parse(`${to}T00:00:00Z`);
    instant += 86_400_000
  ) {
    days.push(new Date(instant).toISOString().slice(0, 10));
  }
  return days;
}

interface NotificationRow {
  type: string;
  eventKey: string;
}

/** The `log_day` notices of the user, by key. */
const logDayOf = (userId: string) =>
  testPrisma().$queryRaw<NotificationRow[]>`
    SELECT type::text AS type, event_key AS "eventKey"
      FROM notification
     WHERE user_id = ${userId}::uuid AND type = 'log_day'::notification_type
     ORDER BY event_key`;

async function keysOf(userId: string): Promise<string[]> {
  return (await logDayOf(userId)).map((row) => row.eventKey);
}

async function newUser(): Promise<TestUser> {
  const user = await createUser({ timezone: LA_PAZ });
  userIds.push(user.id);
  return user;
}

async function setLogDay(
  userId: string,
  values: { enabled?: boolean; hour?: number; weekdays?: number[] },
): Promise<void> {
  const db = testPrisma();
  if (values.enabled !== undefined) {
    await db.$executeRaw`
      UPDATE notification_preference SET enabled = ${values.enabled}
       WHERE user_id = ${userId}::uuid AND type = 'log_day'::notification_type`;
  }
  if (values.hour !== undefined) {
    await db.$executeRaw`
      UPDATE notification_preference SET hour = ${values.hour}::smallint
       WHERE user_id = ${userId}::uuid AND type = 'log_day'::notification_type`;
  }
  if (values.weekdays !== undefined) {
    await db.$executeRaw`
      UPDATE notification_preference SET weekdays = ${values.weekdays}::smallint[]
       WHERE user_id = ${userId}::uuid AND type = 'log_day'::notification_type`;
  }
}

/** A user with `log_day` active and its default hour and weekdays. */
async function activeUser(): Promise<TestUser> {
  const user = await newUser();
  await setLogDay(user.id, { enabled: true });
  return user;
}

// 2090-10-20 is a Friday (weekday 5); 2090-10-21 is a Saturday (weekday 6).
const FRIDAY = '2090-10-20';
const SATURDAY = '2090-10-21';

// ---------- Defaults and hour ----------

describe('notifications.scheduled: registrar el día, hora y valor por defecto', () => {
  it('RF-M15-02 con log_day activo, a las 21:00 crea un aviso con la clave log_day:{fecha}', async () => {
    const user = await activeUser();

    await runAt(laPaz(FRIDAY), [user]);

    const rows = await logDayOf(user.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.type).toBe('log_day');
    expect(rows[0]?.eventKey).toBe(`log_day:${FRIDAY}`);
  });

  it('RF-M15-02 log_day está desactivado por defecto: no se genera nada', async () => {
    const user = await newUser();

    await runAt(laPaz(FRIDAY, '23:00'), [user]);

    expect(await keysOf(user.id)).toEqual([]);
  });

  it('RF-M15-02 antes de las 21:00 locales no se genera, aunque ya pasaron las 08:00', async () => {
    const user = await activeUser();

    await runAt(laPaz(FRIDAY, '08:00'), [user]);
    await runAt(laPaz(FRIDAY, '20:59'), [user]);

    expect(await keysOf(user.id)).toEqual([]);
  });

  it('RF-M15-02 después de su hora, en el mismo día local, se genera', async () => {
    const user = await activeUser();

    // 23:30 in La Paz is already the next day in UTC: the key uses the local date.
    await runAt(laPaz(FRIDAY, '23:30'), [user]);

    expect(await keysOf(user.id)).toEqual([`log_day:${FRIDAY}`]);
  });

  it('RF-M15-02 a la hora elegida por el usuario, no a las 21:00', async () => {
    const user = await activeUser();
    await setLogDay(user.id, { hour: 18 });

    await runAt(laPaz(FRIDAY, '17:59'), [user]);
    expect(await keysOf(user.id)).toEqual([]);

    await runAt(laPaz(FRIDAY, '18:00'), [user]);
    expect(await keysOf(user.id)).toEqual([`log_day:${FRIDAY}`]);
  });

  it('RF-M15-02 con una hora elegida después de las 21:00, a las 21:00 aún no se genera', async () => {
    const user = await activeUser();
    await setLogDay(user.id, { hour: 22 });

    await runAt(laPaz(FRIDAY, '21:00'), [user]);
    expect(await keysOf(user.id)).toEqual([]);

    await runAt(laPaz(FRIDAY, '22:00'), [user]);
    expect(await keysOf(user.id)).toEqual([`log_day:${FRIDAY}`]);
  });
});

// ---------- Weekdays ----------

describe('notifications.scheduled: registrar el día, días de la semana', () => {
  it('RF-M15-02 en un día no elegido no se genera', async () => {
    const user = await activeUser();
    // Every day but Friday (5).
    await setLogDay(user.id, { weekdays: [0, 1, 2, 3, 4, 6] });

    await runAt(laPaz(FRIDAY), [user]);
    await runAt(laPaz(FRIDAY, '23:59'), [user]);

    expect(await keysOf(user.id)).toEqual([]);
  });

  it('RF-M15-02 en un día elegido sí se genera, con los mismos días de la semana', async () => {
    const user = await activeUser();
    await setLogDay(user.id, { weekdays: [0, 1, 2, 3, 4, 6] });

    await runAt(laPaz(SATURDAY), [user]);

    expect(await keysOf(user.id)).toEqual([`log_day:${SATURDAY}`]);
  });

  it('RF-M15-02 una semana con solo lunes y viernes elegidos deja dos avisos', async () => {
    const user = await activeUser();
    await setLogDay(user.id, { weekdays: [1, 5] });

    // 2090-10-16 (Monday) to 2090-10-22 (Sunday).
    for (const day of daysFrom('2090-10-16', '2090-10-22')) {
      await runAt(laPaz(day), [user]);
    }

    expect(await keysOf(user.id)).toEqual(['log_day:2090-10-16', `log_day:${FRIDAY}`]);
  });

  it('RF-M15-02 con todos los días por defecto, una semana deja un aviso por día', async () => {
    const user = await activeUser();
    const days = daysFrom('2090-10-16', '2090-10-22');

    for (const day of days) {
      await runAt(laPaz(day), [user]);
    }

    expect(await keysOf(user.id)).toEqual(days.map((day) => `log_day:${day}`));
  });
});

// ---------- One per day ----------

describe('notifications.scheduled: registrar el día, un aviso por día', () => {
  it('RF-M15-02 correr el job varias veces el mismo día deja un solo aviso', async () => {
    const user = await activeUser();

    await runAt(laPaz(FRIDAY, '21:00'), [user]);
    await runAt(laPaz(FRIDAY, '21:30'), [user]);
    await jobAt(laPaz(FRIDAY, '23:00'), [user]).forUser(user.id);

    expect(await keysOf(user.id)).toEqual([`log_day:${FRIDAY}`]);
  });

  it('RF-M15-02 forUser genera el aviso del usuario a su hora', async () => {
    const user = await activeUser();
    const other = await activeUser();

    await jobAt(laPaz(FRIDAY), [user, other]).forUser(user.id);

    expect(await keysOf(user.id)).toEqual([`log_day:${FRIDAY}`]);
    expect(await keysOf(other.id)).toEqual([]);
  });

  it('RF-M15-02 cada usuario recibe su propio aviso, según su preferencia', async () => {
    const active = await activeUser();
    const inactive = await newUser();

    await runAt(laPaz(FRIDAY), [active, inactive]);

    expect(await keysOf(active.id)).toEqual([`log_day:${FRIDAY}`]);
    expect(await keysOf(inactive.id)).toEqual([]);
  });
});

// ---------- Movements that day ----------

describe('notifications.scheduled: registrar el día aunque haya movimientos', () => {
  it('EC-M15-03 el aviso se genera aunque haya movimientos ese día', async () => {
    const user = await activeUser();
    const account = await createAccount(user.id);
    await createLedgerTransaction(user.id, {
      kind: 'expense',
      date: FRIDAY,
      entries: [{ accountId: account.id, amount: '-25.00' }],
    });
    await createLedgerTransaction(user.id, {
      kind: 'income',
      date: FRIDAY,
      entries: [{ accountId: account.id, amount: '100.00' }],
    });

    await runAt(laPaz(FRIDAY), [user]);

    expect(await keysOf(user.id)).toEqual([`log_day:${FRIDAY}`]);
  });
});

// ---------- Release ----------

describe('notifications.scheduled: registrar el día solo desde la V1.2', () => {
  it('TASK-239 en la V1.1 no se genera el aviso de registrar el día', async () => {
    const user = await activeUser();

    await runAt(laPaz(FRIDAY), [user], '1.1');

    expect(await keysOf(user.id)).toEqual([]);
  });
});
