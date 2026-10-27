import type { Express } from 'express';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { buildContainer, createApp, type Container } from '../../src/composition/container.js';
import { parseEnv } from '../../src/infrastructure/config/env.js';
import { createAccount } from '../factories/account.factory.js';
import { deleteGoalsOf } from '../factories/goal.factory.js';
import { deleteLedgerOf } from '../factories/ledger.factory.js';
import { createRule, deleteRecurringOf, occurrencesOf } from '../factories/recurring.factory.js';
import { disconnectTestPrisma, testPrisma } from '../integration/setup/db.js';

/**
 * `GET` and `PATCH /api/notification-preferences` (plan §4.15.2), only with `RELEASE` = 1.2
 * (RF-M15-07). The plan fixes the body of `PATCH` (`PreferencesInput`, plan §4.15.1): an array of
 * `{ type, enabled, hour?, leadDays?, weekdays? }`. These tests assume that `GET` answers the
 * preferences of the user with the same item shape, as an array, one item per type. What is saved
 * is also read straight from `notification_preference` (plan §3.7).
 *
 * Which type uses which setting comes from RF-M15-02 and RF-M15-09: `log_day` has its hour and its
 * weekdays; the scheduled notices without a configurable hour (payment_upcoming, goal_progress)
 * and the event ones (budget_alert, period_close, recurring_pending) take no hour, and the event
 * ones take no lead days nor weekdays.
 *
 * The users are signed in through the API and keep the default timezone (`America/La_Paz`).
 */
const WEB_ORIGIN = 'http://localhost:5173';
const COOKIE_NAME = '__Secure-better-auth.session_token';
const TIMEZONE = 'America/La_Paz';
const PATH = '/api/notification-preferences';

const TYPES = [
  'payment_upcoming',
  'budget_alert',
  'period_close',
  'recurring_pending',
  'log_day',
  'goal_progress',
] as const;
type PreferenceType = (typeof TYPES)[number];

const envSource = (): Record<string, string> => ({
  NODE_ENV: 'test',
  PORT: '3000',
  DATABASE_URL: process.env['TEST_DATABASE_URL'] ?? '',
  AUTH_SECRET: 'auth-secret-value-0123456789abcdef0123456789',
  HMAC_SECRET: 'hmac-secret-value-0123456789abcdef0123456789',
  JOBS_SECRET: 'jobs-secret-value-0123456789abcdef0123456789',
  RESEND_API_KEY: 're_resend-key-value-0123456789',
  RELEASE: '1.2',
  WEB_ORIGIN,
  INTEGRATIONS: 'fake',
});

interface Problem {
  code?: string;
  status?: number;
}
const problem = (res: { body: unknown }) => res.body as Problem;

interface PreferenceItem {
  type: string;
  enabled: boolean;
  hour?: number | null;
  leadDays?: number | null;
  weekdays?: number[] | null;
}
const preferencesOf = (res: { body: unknown }): PreferenceItem[] => {
  expect(Array.isArray(res.body)).toBe(true);
  return res.body as PreferenceItem[];
};

interface OverviewBody {
  pending: unknown[];
}
const overviewOf = (res: { body: unknown }) => res.body as OverviewBody;

interface Account {
  cookie: string;
  userId: string;
}

interface StoredPreference {
  type: string;
  enabled: boolean;
  hour: number | null;
  leadDays: number | null;
  weekdays: number[] | null;
}

const db = testPrisma();
let container: Container;
let app: Express;
const usedEmails: string[] = [];
const usedUsers: string[] = [];
const originalRelease = process.env['RELEASE'];

const sleep = (ms: number) =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });

/** Today in the timezone of the users of this file. */
const localToday = (): string =>
  new Intl.DateTimeFormat('en-CA', {
    timeZone: TIMEZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());

const sessionCookieOf = (res: { headers: Record<string, unknown> }): string => {
  const raw = res.headers['set-cookie'];
  const list = typeof raw === 'string' ? [raw] : Array.isArray(raw) ? (raw as unknown[]) : [];
  const header = list.find(
    (c): c is string => typeof c === 'string' && c.startsWith(`${COOKIE_NAME}=`),
  );
  if (header === undefined) throw new Error('the response sets no session cookie');
  return header.split(';')[0] ?? '';
};

async function signedIn(): Promise<Account> {
  const support = container.testSupport;
  if (support === null) throw new Error('test support is off');
  const { email, password } = await support.createUser();
  usedEmails.push(email);
  const res = await request(app)
    .post('/api/auth/sign-in')
    .set('Origin', WEB_ORIGIN)
    .send({ email, password });
  expect(res.status).toBe(200);
  const rows = await db.$queryRaw<{ id: string }[]>`
    SELECT id::text AS id FROM auth_user WHERE email = ${email}`;
  const userId = rows[0]?.id;
  if (userId === undefined) throw new Error('the signed-in user is not in auth_user');
  usedUsers.push(userId);
  return { cookie: sessionCookieOf(res), userId };
}

const getPreferences = (cookie: string | null) => {
  const req = request(app).get(PATH);
  if (cookie !== null) req.set('Cookie', cookie);
  return req;
};

const patchPreferences = (cookie: string | null, body: unknown) => {
  const req = request(app).patch(PATH).set('Origin', WEB_ORIGIN);
  if (cookie !== null) req.set('Cookie', cookie);
  return req.send(body as object);
};

const expectSuccess = (res: { status: number; text: string }) => {
  expect(res.status, res.text).toBeGreaterThanOrEqual(200);
  expect(res.status, res.text).toBeLessThan(300);
};

/** The stored preferences of the user, by type. */
async function storedPreferences(userId: string): Promise<Map<string, StoredPreference>> {
  const rows = await db.$queryRaw<StoredPreference[]>`
    SELECT type::text AS type, enabled, hour::int AS hour, lead_days::int AS "leadDays",
           weekdays::int[] AS weekdays
      FROM notification_preference WHERE user_id = ${userId}::uuid`;
  return new Map(rows.map((row) => [row.type, row]));
}

const stored = async (userId: string, type: PreferenceType) => {
  const row = (await storedPreferences(userId)).get(type);
  if (row === undefined) throw new Error(`the user has no ${type} preference`);
  return row;
};

const recurringPendingNotices = async (userId: string) =>
  db.$queryRaw<{ id: string; eventKey: string }[]>`
    SELECT id::text AS id, event_key AS "eventKey" FROM notification
     WHERE user_id = ${userId}::uuid AND type = 'recurring_pending'::notification_type`;

/**
 * A monthly rule in confirmation mode (no amount) due today, on a bank account opened long ago:
 * the catch-up of the user leaves its occurrence of today pending (plan §4.14.3).
 */
async function pendingDueToday(userId: string) {
  const today = localToday();
  const account = await createAccount(userId, { initialBalanceDate: '2020-01-01' });
  const rule = await createRule(userId, {
    accountId: account.id,
    amount: null,
    dayOfMonth: Number(today.slice(8, 10)),
    startDate: today,
  });
  await container.jobs.catchUpUser(userId);
  const occurrences = await occurrencesOf(rule.id);
  expect(occurrences.map((o) => [o.scheduledDate, o.status])).toEqual([[today, 'pending']]);
  const occurrence = occurrences[0];
  if (occurrence === undefined) throw new Error('no pending occurrence was generated');
  return { rule, occurrence };
}

beforeAll(async () => {
  process.env['RELEASE'] = '1.2';
  container = await Promise.resolve(buildContainer(parseEnv(envSource())));
  app = await Promise.resolve(createApp(container));
}, 30_000);

afterEach(() => {
  process.env['RELEASE'] = '1.2';
});

afterAll(async () => {
  if (originalRelease === undefined) delete process.env['RELEASE'];
  else process.env['RELEASE'] = originalRelease;
  await sleep(300);
  await deleteRecurringOf(usedUsers);
  await deleteGoalsOf(usedUsers);
  await deleteLedgerOf(usedUsers);
  await db.$executeRaw`DELETE FROM auth_user WHERE email = ANY(${usedEmails}::text[])`;
  await db.$executeRaw`DELETE FROM email_outbox WHERE to_address = ANY(${usedEmails}::text[])`;
  await disconnectTestPrisma();
  await container.prisma.$disconnect();
}, 60_000);

describe('release gate and session', () => {
  it('RF-M15-07 con RELEASE=1.1 la configuración de avisos responde 404 RELEASE_NOT_AVAILABLE y no cambia nada', async () => {
    const { cookie, userId } = await signedIn();
    process.env['RELEASE'] = '1.1';

    const read = await getPreferences(cookie);
    expect(read.status).toBe(404);
    expect(problem(read).code).toBe('RELEASE_NOT_AVAILABLE');

    const write = await patchPreferences(cookie, [{ type: 'budget_alert', enabled: false }]);
    expect(write.status).toBe(404);
    expect(problem(write).code).toBe('RELEASE_NOT_AVAILABLE');

    expect((await stored(userId, 'budget_alert')).enabled).toBe(true);
  });

  it('RF-M15-07 con RELEASE=1.2 la configuración de avisos está disponible', async () => {
    const { cookie } = await signedIn();

    const res = await getPreferences(cookie);

    expect(res.status, res.text).toBe(200);
  });

  it('TASK-237 sin sesión GET y PATCH responden 401', async () => {
    expect((await getPreferences(null)).status).toBe(401);
    expect((await patchPreferences(null, [{ type: 'budget_alert', enabled: false }])).status).toBe(
      401,
    );
  });
});

describe('GET /api/notification-preferences', () => {
  it('TASK-237 una cuenta nueva lee los seis tipos con sus valores por defecto', async () => {
    const { cookie } = await signedIn();

    const res = await getPreferences(cookie);

    expect(res.status, res.text).toBe(200);
    const items = preferencesOf(res);
    expect(items.map((p) => p.type).sort()).toEqual([...TYPES].sort());
    const byType = new Map(items.map((p) => [p.type, p]));
    expect(byType.get('payment_upcoming')?.enabled).toBe(true);
    expect(byType.get('budget_alert')?.enabled).toBe(true);
    expect(byType.get('period_close')?.enabled).toBe(true);
    expect(byType.get('recurring_pending')?.enabled).toBe(true);
    expect(byType.get('goal_progress')?.enabled).toBe(false);
    const logDay = byType.get('log_day');
    expect(logDay?.enabled).toBe(false);
    expect(logDay?.hour).toBe(21);
    expect([...(logDay?.weekdays ?? [])].sort()).toEqual([0, 1, 2, 3, 4, 5, 6]);
  });

  it('TASK-237 un usuario solo lee sus propias preferencias', async () => {
    const a = await signedIn();
    const b = await signedIn();
    expectSuccess(await patchPreferences(a.cookie, [{ type: 'budget_alert', enabled: false }]));

    const res = await getPreferences(b.cookie);

    expect(res.status, res.text).toBe(200);
    const items = preferencesOf(res);
    expect(items).toHaveLength(TYPES.length);
    expect(items.find((p) => p.type === 'budget_alert')?.enabled).toBe(true);
  });
});

describe('PATCH /api/notification-preferences', () => {
  it('RF-M15-03 todos los tipos pueden desactivarse', async () => {
    const { cookie, userId } = await signedIn();

    const res = await patchPreferences(
      cookie,
      TYPES.map((type) => ({ type, enabled: false })),
    );

    expectSuccess(res);
    const rows = await storedPreferences(userId);
    for (const type of TYPES) {
      expect(rows.get(type)?.enabled, type).toBe(false);
    }
    const read = await getPreferences(cookie);
    expect(read.status, read.text).toBe(200);
    expect(preferencesOf(read).every((p) => !p.enabled)).toBe(true);
  });

  it('TASK-237 un tipo desactivado se puede volver a activar', async () => {
    const { cookie, userId } = await signedIn();
    expectSuccess(await patchPreferences(cookie, [{ type: 'period_close', enabled: false }]));

    expectSuccess(await patchPreferences(cookie, [{ type: 'period_close', enabled: true }]));

    expect((await stored(userId, 'period_close')).enabled).toBe(true);
  });

  it('TASK-237 un PATCH de un tipo no cambia los demás', async () => {
    const { cookie, userId } = await signedIn();
    const before = await storedPreferences(userId);

    expectSuccess(await patchPreferences(cookie, [{ type: 'recurring_pending', enabled: false }]));

    const after = await storedPreferences(userId);
    expect(after.get('recurring_pending')?.enabled).toBe(false);
    for (const type of TYPES.filter((t) => t !== 'recurring_pending')) {
      expect(after.get(type), type).toEqual(before.get(type));
    }
  });

  it('TASK-237 log_day acepta su hora y sus días de la semana', async () => {
    const { cookie, userId } = await signedIn();

    const res = await patchPreferences(cookie, [
      { type: 'log_day', enabled: true, hour: 7, weekdays: [1, 3, 5] },
    ]);

    expectSuccess(res);
    const row = await stored(userId, 'log_day');
    expect(row.enabled).toBe(true);
    expect(row.hour).toBe(7);
    expect([...(row.weekdays ?? [])].sort()).toEqual([1, 3, 5]);
    const read = preferencesOf(await getPreferences(cookie)).find((p) => p.type === 'log_day');
    expect(read?.hour).toBe(7);
    expect([...(read?.weekdays ?? [])].sort()).toEqual([1, 3, 5]);
  });

  const rejected: [string, unknown][] = [
    ['una hora en budget_alert', [{ type: 'budget_alert', enabled: true, hour: 9 }]],
    ['una hora en period_close', [{ type: 'period_close', enabled: true, hour: 9 }]],
    ['una hora en recurring_pending', [{ type: 'recurring_pending', enabled: true, hour: 9 }]],
    ['una hora en payment_upcoming', [{ type: 'payment_upcoming', enabled: true, hour: 9 }]],
    ['una hora en goal_progress', [{ type: 'goal_progress', enabled: true, hour: 9 }]],
    ['una anticipación en budget_alert', [{ type: 'budget_alert', enabled: true, leadDays: 2 }]],
    ['una anticipación en period_close', [{ type: 'period_close', enabled: true, leadDays: 2 }]],
    [
      'una anticipación en recurring_pending',
      [{ type: 'recurring_pending', enabled: true, leadDays: 2 }],
    ],
    ['días de la semana en budget_alert', [{ type: 'budget_alert', enabled: true, weekdays: [1] }]],
    [
      'días de la semana en recurring_pending',
      [{ type: 'recurring_pending', enabled: true, weekdays: [1] }],
    ],
    ['una hora fuera de 0 a 23', [{ type: 'log_day', enabled: true, hour: 24 }]],
    ['un día de la semana fuera de 0 a 6', [{ type: 'log_day', enabled: true, weekdays: [7] }]],
    ['un tipo desconocido', [{ type: 'fx_change', enabled: true }]],
    ['un enabled que no es booleano', [{ type: 'budget_alert', enabled: 'no' }]],
    ['un cuerpo que no es una lista', { type: 'budget_alert', enabled: false }],
  ];
  for (const [label, body] of rejected) {
    it(`TASK-237 PATCH con ${label} responde 400 VALIDATION_ERROR y no cambia nada`, async () => {
      const { cookie, userId } = await signedIn();
      const before = await storedPreferences(userId);

      const res = await patchPreferences(cookie, body);

      expect(res.status, res.text).toBe(400);
      expect(problem(res).code).toBe('VALIDATION_ERROR');
      expect(await storedPreferences(userId)).toEqual(before);
    });
  }

  it('TASK-237 un PATCH de un usuario no cambia las preferencias de otro', async () => {
    const a = await signedIn();
    const b = await signedIn();
    const before = await storedPreferences(a.userId);

    expectSuccess(await patchPreferences(b.cookie, TYPES.map((type) => ({ type, enabled: false }))));

    expect(await storedPreferences(a.userId)).toEqual(before);
  });
});

describe('RF-M15-03 Decisión visible con el aviso desactivado', () => {
  it('RF-M15-03 Decisión visible con el aviso desactivado: el pendiente no crea aviso y sí aparece en /api/recurring', async () => {
    const { cookie, userId } = await signedIn();
    expectSuccess(await patchPreferences(cookie, [{ type: 'recurring_pending', enabled: false }]));

    const { occurrence } = await pendingDueToday(userId);

    expect(await recurringPendingNotices(userId)).toEqual([]);
    const inbox = await request(app).get('/api/notifications').set('Cookie', cookie);
    expect(inbox.status, inbox.text).toBe(200);
    expect(inbox.text).not.toContain(occurrence.id);
    const overview = await request(app).get('/api/recurring').set('Cookie', cookie);
    expect(overview.status, overview.text).toBe(200);
    expect(JSON.stringify(overviewOf(overview).pending)).toContain(occurrence.id);
  });

  it('RF-M15-03 con recurring_pending activo el mismo pendiente sí crea su aviso', async () => {
    const { cookie, userId } = await signedIn();
    expectSuccess(await patchPreferences(cookie, [{ type: 'recurring_pending', enabled: true }]));

    const { occurrence } = await pendingDueToday(userId);

    const notices = await recurringPendingNotices(userId);
    expect(notices.map((n) => n.eventKey)).toEqual([`recurring_pending:${occurrence.id}`]);
  });
});
