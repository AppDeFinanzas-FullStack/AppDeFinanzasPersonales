import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createScheduledNotifications } from '../../src/application/jobs/notifications.js';
import type { Clock } from '../../src/application/ports/clock.js';
import type { UnitOfWork } from '../../src/application/ports/unit-of-work.js';
import { buildContainer, type Container } from '../../src/composition/container.js';
import { parseEnv } from '../../src/infrastructure/config/env.js';
import { createAccount, type TestAccount } from '../factories/account.factory.js';
import {
  createRule,
  deleteRecurringOf,
  type CreateRuleOptions,
  type TestRule,
} from '../factories/recurring.factory.js';
import { createUser, deleteCreatedUsers, type TestUser } from '../factories/user.factory.js';
import { disconnectTestPrisma, testDatabaseUrl, testPrisma } from './setup/db.js';

/**
 * TASK-238 extends the job `notifications.scheduled` (plan §4.15.3) with the upcoming payments of
 * RF-M15-02, from the V1.2 (RF-M4-08, plan §4.15.3 "Entrega"): at 08:00 local time (RF-M15-09) it
 * creates today's `payment_upcoming` notices of
 * - the expense and transfer recurring rules with a weekly frequency or longer (not daily), the
 *   configured lead days before their next date (`notification_preference.lead_days`, 1 by
 *   default); a rule without amount says "monto por definir";
 * - the credit cards, on the cut day and 3 days before the pay day; when the month has no such day,
 *   it falls on its last day (RF-M4-08).
 * The key includes the date and only today is evaluated (RF-M15-10, EC-M15-02).
 *
 * These tests reuse the interface of the job fixed by TASK-215:
 * `createScheduledNotifications({ uow, clock, release, users })` returns `{ run, forUser }`. The
 * plan does not fix the exact `event_key` of these notices nor their `params`, so the tests count
 * notices and only check that the params carry the amount of the rule as decimal text (ADR-03) or,
 * without amount, no amount at all (the text "monto por definir" is the web's i18n).
 */
const envSource = (): Record<string, string> => ({
  NODE_ENV: 'test',
  PORT: '3000',
  DATABASE_URL: testDatabaseUrl(),
  AUTH_SECRET: 'auth-secret-for-the-notifications-payments-job-test',
  HMAC_SECRET: 'hmac-secret-for-the-notifications-payments-job-test',
  JOBS_SECRET: 'jobs-secret-for-the-notifications-payments-job-test',
  RESEND_API_KEY: 'resend-key-for-the-notifications-payments-job-test',
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
  await deleteRecurringOf(userIds);
  await deleteCreatedUsers();
  await container.prisma.$disconnect();
  await disconnectTestPrisma();
});

// ---------- Helpers ----------

const LA_PAZ = 'America/La_Paz'; // UTC-4, no daylight saving.

/** The instant of that local time in La Paz (UTC-4). */
const laPaz = (date: string, time = '08:00'): Date => new Date(`${date}T${time}:00-04:00`);

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

/** Runs the batch handler of the job at that instant, over those users. */
async function runAt(instant: Date, users: TestUser[], release: Release = '1.2'): Promise<void> {
  await createScheduledNotifications({
    uow,
    clock: clockAt(instant),
    release,
    users: usersPort(users),
  }).run();
}

/** Runs the job at 08:00 local time on each of those days. */
async function runOnDays(days: string[], user: TestUser): Promise<void> {
  for (const day of days) {
    await runAt(laPaz(day), [user]);
  }
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
  params: unknown;
  createdAt: Date;
}

const notificationsOf = (userId: string) =>
  testPrisma().$queryRaw<NotificationRow[]>`
    SELECT type::text AS type, event_key AS "eventKey", params, created_at AS "createdAt"
      FROM notification WHERE user_id = ${userId}::uuid ORDER BY created_at, event_key`;

async function countOf(userId: string): Promise<number> {
  return (await notificationsOf(userId)).length;
}

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

async function newUser(): Promise<TestUser> {
  const user = await createUser({ timezone: LA_PAZ });
  userIds.push(user.id);
  return user;
}

/** A weekly rule on that weekday (0 = Sunday), starting on 2090-01-01. */
async function weeklyRule(
  userId: string,
  weekday: number,
  options: CreateRuleOptions = {},
): Promise<TestRule> {
  const rule = await createRule(userId, { startDate: '2090-01-01', ...options });
  await testPrisma().$executeRaw`
    UPDATE recurring_rule SET frequency = 'weekly', weekday = ${weekday}::smallint, day_of_month = NULL
     WHERE id = ${rule.id}::uuid`;
  return rule;
}

/** A daily rule starting on 2090-01-01. */
async function dailyRule(userId: string, options: CreateRuleOptions = {}): Promise<TestRule> {
  const rule = await createRule(userId, { startDate: '2090-01-01', ...options });
  await testPrisma().$executeRaw`
    UPDATE recurring_rule SET frequency = 'daily', weekday = NULL, day_of_month = NULL
     WHERE id = ${rule.id}::uuid`;
  return rule;
}

/** A credit card with a debt, with those cut and pay days. */
async function card(
  userId: string,
  cardCutDay: number | null,
  cardPayDay: number | null,
): Promise<TestAccount> {
  const account = await createAccount(userId, {
    type: 'credit_card',
    initialBalance: '-500.00',
  });
  // The factory turns an explicit null into its default days: write them exactly.
  await testPrisma().$executeRaw`
    UPDATE account
       SET card_cut_day = ${cardCutDay}::smallint, card_pay_day = ${cardPayDay}::smallint
     WHERE id = ${account.id}::uuid`;
  return account;
}

async function setPreference(
  userId: string,
  values: { enabled?: boolean; leadDays?: number },
): Promise<void> {
  if (values.enabled !== undefined) {
    await testPrisma().$executeRaw`
      UPDATE notification_preference SET enabled = ${values.enabled}
       WHERE user_id = ${userId}::uuid AND type = 'payment_upcoming'::notification_type`;
  }
  if (values.leadDays !== undefined) {
    await testPrisma().$executeRaw`
      UPDATE notification_preference SET lead_days = ${values.leadDays}::smallint
       WHERE user_id = ${userId}::uuid AND type = 'payment_upcoming'::notification_type`;
  }
}

async function setPayDay(account: TestAccount, day: number): Promise<void> {
  await testPrisma().$executeRaw`
    UPDATE account SET card_pay_day = ${day}::smallint WHERE id = ${account.id}::uuid`;
}

// 2090-10-20 is a Friday (weekday 5); 2090-10-19 is a Thursday.
const FRIDAY = 5;

// ---------- Recurring rules ----------

describe('notifications.scheduled: pagos próximos de recurrentes', () => {
  it('RF-M15-02 una regla semanal genera un aviso un día antes de su fecha', async () => {
    const user = await newUser();
    await weeklyRule(user.id, FRIDAY);

    await runAt(laPaz('2090-10-19'), [user]);

    const rows = await notificationsOf(user.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.type).toBe('payment_upcoming');
    expect(stringValues(rows[0]?.params)).toContain('150.00');
  });

  it('RF-M15-02 una regla semanal no avisa los otros días de la semana', async () => {
    const user = await newUser();
    await weeklyRule(user.id, FRIDAY);

    await runOnDays(['2090-10-14', '2090-10-15', '2090-10-16', '2090-10-17', '2090-10-18'], user);
    await runOnDays(['2090-10-20'], user);

    expect(await countOf(user.id)).toBe(0);
  });

  it('RF-M15-02 una corrida diaria de dos semanas deja un aviso por cada semana', async () => {
    const user = await newUser();
    await weeklyRule(user.id, FRIDAY);

    await runOnDays(daysFrom('2090-10-14', '2090-10-27'), user);

    expect(await countOf(user.id)).toBe(2);
  });

  it('RF-M15-02 una regla diaria no genera aviso', async () => {
    const user = await newUser();
    await dailyRule(user.id);
    await dailyRule(user.id, { kind: 'transfer' });

    await runOnDays(daysFrom('2090-10-15', '2090-10-21'), user);

    expect(await countOf(user.id)).toBe(0);
  });

  it('RF-M15-02 una regla mensual genera un aviso un día antes de su fecha', async () => {
    const user = await newUser();
    await createRule(user.id, { dayOfMonth: 5, startDate: '2090-01-05', amount: '320.50' });

    await runOnDays(daysFrom('2090-10-01', '2090-10-08'), user);

    const rows = await notificationsOf(user.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.type).toBe('payment_upcoming');
    expect(stringValues(rows[0]?.params)).toContain('320.50');
  });

  it('RF-M15-02 una regla de transferencia semanal también genera su aviso', async () => {
    const user = await newUser();
    await weeklyRule(user.id, FRIDAY, { kind: 'transfer', amount: '75.00' });

    await runAt(laPaz('2090-10-19'), [user]);

    const rows = await notificationsOf(user.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.type).toBe('payment_upcoming');
    expect(stringValues(rows[0]?.params)).toContain('75.00');
  });

  it('RF-M15-02 una regla de ingreso no genera aviso de pago próximo', async () => {
    const user = await newUser();
    await weeklyRule(user.id, FRIDAY, { kind: 'income' });
    await createRule(user.id, { kind: 'income', dayOfMonth: 5 });

    await runOnDays(['2090-10-04', '2090-10-19'], user);

    expect(await countOf(user.id)).toBe(0);
  });

  it('RF-M15-02 una regla sin monto genera el aviso como "monto por definir", sin monto', async () => {
    const user = await newUser();
    await weeklyRule(user.id, FRIDAY, { amount: null });

    await runAt(laPaz('2090-10-19'), [user]);

    const rows = await notificationsOf(user.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.type).toBe('payment_upcoming');
    const amounts = stringValues(rows[0]?.params).filter((value) => /^-?\d+\.\d{2}$/.test(value));
    expect(amounts).toEqual([]);
  });

  it('RF-M15-02 con la anticipación configurada en 3 días, el aviso llega 3 días antes', async () => {
    const user = await newUser();
    await setPreference(user.id, { leadDays: 3 });
    await weeklyRule(user.id, FRIDAY);

    await runOnDays(['2090-10-18', '2090-10-19', '2090-10-20'], user);
    expect(await countOf(user.id)).toBe(0);

    await runOnDays(['2090-10-17'], user);
    expect(await countOf(user.id)).toBe(1);
  });

  it('RF-M15-09 antes de las 08:00 locales no se genera el aviso y a las 08:00 sí', async () => {
    const user = await newUser();
    await weeklyRule(user.id, FRIDAY);

    await runAt(laPaz('2090-10-19', '07:59'), [user]);
    expect(await countOf(user.id)).toBe(0);

    await runAt(laPaz('2090-10-19', '08:00'), [user]);
    expect(await countOf(user.id)).toBe(1);
  });

  it('RF-M15-02 correr el job dos veces el mismo día deja un solo aviso', async () => {
    const user = await newUser();
    await weeklyRule(user.id, FRIDAY);

    await runAt(laPaz('2090-10-19', '08:00'), [user]);
    await runAt(laPaz('2090-10-19', '18:00'), [user]);

    expect(await countOf(user.id)).toBe(1);
  });

  it('RF-M15-10 al reactivar el tipo no se generan avisos de días pasados', async () => {
    const user = await newUser();
    await weeklyRule(user.id, FRIDAY);

    await setPreference(user.id, { enabled: false });
    await runOnDays(['2090-10-18', '2090-10-19'], user);
    expect(await countOf(user.id)).toBe(0);

    await setPreference(user.id, { enabled: true });
    await runOnDays(['2090-10-20', '2090-10-21'], user);
    expect(await countOf(user.id)).toBe(0);

    // The next one, on the Thursday before the next Friday, does arrive.
    await runOnDays(['2090-10-26'], user);
    expect(await countOf(user.id)).toBe(1);
  });

  it('RF-M4-08 con RELEASE=1.1 las recurrentes no generan avisos', async () => {
    const user = await newUser();
    await weeklyRule(user.id, FRIDAY);

    await runAt(laPaz('2090-10-19'), [user], '1.1');

    expect(await countOf(user.id)).toBe(0);
  });

  it('TASK-238 cada usuario recibe solo los avisos de sus propias recurrentes', async () => {
    const owner = await newUser();
    const other = await newUser();
    await weeklyRule(owner.id, FRIDAY);

    await runAt(laPaz('2090-10-19'), [owner, other]);

    expect(await countOf(owner.id)).toBe(1);
    expect(await countOf(other.id)).toBe(0);
  });
});

// ---------- Credit cards ----------

describe('notifications.scheduled: corte y pago de tarjetas', () => {
  it('RF-M15-02 una tarjeta avisa el día del corte', async () => {
    const user = await newUser();
    await card(user.id, 5, null);

    await runOnDays(['2090-10-04'], user);
    expect(await countOf(user.id)).toBe(0);

    await runOnDays(['2090-10-05'], user);
    const rows = await notificationsOf(user.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.type).toBe('payment_upcoming');
  });

  it('RF-M15-02 una tarjeta avisa 3 días antes del pago', async () => {
    const user = await newUser();
    await card(user.id, null, 20);

    await runOnDays(['2090-10-16', '2090-10-18', '2090-10-19', '2090-10-20'], user);
    expect(await countOf(user.id)).toBe(0);

    await runOnDays(['2090-10-17'], user);
    const rows = await notificationsOf(user.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.type).toBe('payment_upcoming');
  });

  it('RF-M15-02 una corrida diaria de un mes deja el aviso del corte y el del pago', async () => {
    const user = await newUser();
    await card(user.id, 5, 20);

    await runOnDays(daysFrom('2090-10-01', '2090-10-31'), user);

    expect(await countOf(user.id)).toBe(2);
  });

  it('RF-M15-02 una tarjeta sin día de corte ni de pago no genera avisos', async () => {
    const user = await newUser();
    await card(user.id, null, null);

    await runOnDays(daysFrom('2090-10-01', '2090-10-31'), user);

    expect(await countOf(user.id)).toBe(0);
  });

  it('RF-M15-02 un pago a inicio de mes avisa 3 días antes, a fines del mes anterior', async () => {
    const user = await newUser();
    await card(user.id, null, 2);

    // 2090-11-02 minus 3 days is 2090-10-30.
    await runOnDays(['2090-10-29', '2090-10-31', '2090-11-01', '2090-11-02'], user);
    expect(await countOf(user.id)).toBe(0);

    await runOnDays(['2090-10-30'], user);
    expect(await countOf(user.id)).toBe(1);
  });

  it('RF-M4-08 una tarjeta con corte el 31 en noviembre avisa el 30', async () => {
    const user = await newUser();
    await card(user.id, 31, null);

    await runOnDays(daysFrom('2090-11-01', '2090-11-29'), user);
    expect(await countOf(user.id)).toBe(0);

    await runOnDays(['2090-11-30'], user);
    expect(await countOf(user.id)).toBe(1);
  });

  it('RF-M4-08 una tarjeta con pago el 31 en noviembre avisa 3 días antes del 30', async () => {
    const user = await newUser();
    await card(user.id, null, 31);

    await runOnDays(['2090-11-26', '2090-11-28', '2090-11-29', '2090-11-30'], user);
    expect(await countOf(user.id)).toBe(0);

    await runOnDays(['2090-11-27'], user);
    expect(await countOf(user.id)).toBe(1);
  });

  it('RF-M4-08 una tarjeta con corte el 30 en febrero avisa el último día del mes', async () => {
    const user = await newUser();
    await card(user.id, 30, null);

    // 2091 is not a leap year: February ends on the 28th.
    await runOnDays(daysFrom('2091-02-01', '2091-02-27'), user);
    expect(await countOf(user.id)).toBe(0);

    await runOnDays(['2091-02-28'], user);
    expect(await countOf(user.id)).toBe(1);
  });

  it('RF-M4-08 con RELEASE=1.1 las tarjetas no generan avisos', async () => {
    const user = await newUser();
    await card(user.id, 5, 20);

    await runAt(laPaz('2090-10-05'), [user], '1.1');
    await runAt(laPaz('2090-10-17'), [user], '1.1');

    expect(await countOf(user.id)).toBe(0);
  });

  it('RF-M15-09 el aviso del corte llega a las 08:00 locales y no antes', async () => {
    const user = await newUser();
    await card(user.id, 5, null);

    await runAt(laPaz('2090-10-05', '07:30'), [user]);
    expect(await countOf(user.id)).toBe(0);

    await runAt(laPaz('2090-10-05', '08:15'), [user]);
    expect(await countOf(user.id)).toBe(1);
  });

  it('EC-M15-02 si cambia el día de pago después de generado el aviso, no se repite', async () => {
    const user = await newUser();
    const account = await card(user.id, null, 20);

    await runAt(laPaz('2090-10-17', '08:00'), [user]);
    expect(await countOf(user.id)).toBe(1);
    const [first] = await notificationsOf(user.id);

    await setPayDay(account, 25);
    await runAt(laPaz('2090-10-17', '12:00'), [user]);

    const rows = await notificationsOf(user.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.eventKey).toBe(first?.eventKey);
  });

  it('EC-M15-02 el próximo aviso usa la nueva fecha de pago', async () => {
    const user = await newUser();
    const account = await card(user.id, null, 20);

    await runAt(laPaz('2090-10-17'), [user]);
    expect(await countOf(user.id)).toBe(1);

    await setPayDay(account, 25);
    // The new pay day is 2090-10-25: its notice is on 2090-10-22, not before.
    await runOnDays(['2090-10-18', '2090-10-19', '2090-10-20', '2090-10-21'], user);
    expect(await countOf(user.id)).toBe(1);

    await runOnDays(['2090-10-22'], user);
    const rows = await notificationsOf(user.id);
    expect(rows).toHaveLength(2);
    expect(new Set(rows.map((row) => row.eventKey)).size).toBe(2);
  });

  it('RF-M15-10 al reactivar el tipo no llega el aviso de un corte pasado', async () => {
    const user = await newUser();
    await card(user.id, 18, null);

    await setPreference(user.id, { enabled: false });
    await runOnDays(['2090-10-18'], user);
    await setPreference(user.id, { enabled: true });
    await runOnDays(['2090-10-19', '2090-10-20'], user);
    expect(await countOf(user.id)).toBe(0);

    await runOnDays(['2090-11-18'], user);
    expect(await countOf(user.id)).toBe(1);
  });

  it('TASK-238 cada usuario recibe solo los avisos de sus propias tarjetas', async () => {
    const owner = await newUser();
    const other = await newUser();
    await card(owner.id, 5, null);

    await runAt(laPaz('2090-10-05'), [owner, other]);

    expect(await countOf(owner.id)).toBe(1);
    expect(await countOf(other.id)).toBe(0);
  });
});
