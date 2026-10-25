import type {
  DashboardDto,
  NotificationDto,
  RecurringOverviewDto,
  UpcomingItemDto,
} from '@finanzas/contracts';
import type { Express } from 'express';
import request from 'supertest';
import { uuidv7 } from 'uuidv7';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { buildContainer, createApp, type Container } from '../../src/composition/container.js';
import { parseEnv } from '../../src/infrastructure/config/env.js';
import { createAccount } from '../factories/account.factory.js';
import { createCategory } from '../factories/category.factory.js';
import { deleteLedgerOf } from '../factories/ledger.factory.js';
import { createRule, deleteRecurringOf, uniqueRuleName } from '../factories/recurring.factory.js';
import { disconnectTestPrisma, testPrisma } from '../integration/setup/db.js';

/**
 * `GET /api/dashboard?month` block `upcoming` with the recurring rules (plan §4.8.1, RF-M8-09):
 * since the V1.2, the expense and transfer rules due in the next 7 days join the debts and cards.
 * With RELEASE=1.1 the block has no recurring rules. Disabling the notice of a pending
 * (RF-M15-03) never hides the pending from Recurrentes.
 */
const WEB_ORIGIN = 'http://localhost:5173';
const COOKIE_NAME = '__Secure-better-auth.session_token';

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

const db = testPrisma();
let container: Container;
let app: Express;
const usedEmails: string[] = [];
const usedUsers: string[] = [];
const originalRelease = process.env['RELEASE'];

const sessionCookieOf = (res: { headers: Record<string, unknown> }): string => {
  const raw = res.headers['set-cookie'];
  const list = typeof raw === 'string' ? [raw] : Array.isArray(raw) ? (raw as unknown[]) : [];
  const header = list.find(
    (c): c is string => typeof c === 'string' && c.startsWith(`${COOKIE_NAME}=`),
  );
  if (header === undefined) throw new Error('the response sets no session cookie');
  return header.split(';')[0] ?? '';
};

interface Account {
  cookie: string;
  userId: string;
}

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

const dashboard = (month: string, cookie: string) =>
  request(app).get(`/api/dashboard?month=${month}`).set('Cookie', cookie);

const bodyOf = (res: { body: unknown }) => res.body as DashboardDto;

interface Today {
  today: string;
  month: string;
  in3: string;
  in8: string;
}

/** Today's calendar data in the timezone of the user (real clock). */
async function todayOf(userId: string): Promise<Today> {
  const rows = await db.$queryRaw<Today[]>`
    SELECT to_char(d, 'YYYY-MM-DD') AS today,
           to_char(d, 'YYYY-MM') AS month,
           to_char(d + 3, 'YYYY-MM-DD') AS in3,
           to_char(d + 8, 'YYYY-MM-DD') AS in8
      FROM (SELECT (now() AT TIME ZONE timezone)::date AS d
              FROM auth_user WHERE id = ${userId}::uuid) t`;
  const found = rows[0];
  if (found === undefined) throw new Error('the user has no timezone');
  return found;
}

const dayOf = (date: string): number => Number(date.slice(8, 10));

/** The items of the block that come from the given rule. */
const itemsOf = (
  upcoming: UpcomingItemDto[] | undefined,
  rule: { id: string; name: string },
): UpcomingItemDto[] =>
  (upcoming ?? []).filter((item) => item.id === rule.id || item.name === rule.name);

/** A monthly rule whose first and next date is `dueDate`. */
const ruleDueOn = (userId: string, dueDate: string, kind: 'expense' | 'transfer' = 'expense') =>
  createRule(userId, {
    kind,
    name: uniqueRuleName('Recurrente'),
    dayOfMonth: dayOf(dueDate),
    startDate: dueDate,
  });

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
  await deleteRecurringOf(usedUsers);
  await deleteLedgerOf(usedUsers);
  await db.$executeRaw`DELETE FROM auth_user WHERE email = ANY(${usedEmails}::text[])`;
  await db.$executeRaw`DELETE FROM email_outbox WHERE to_address = ANY(${usedEmails}::text[])`;
  await disconnectTestPrisma();
  await container.prisma.$disconnect();
}, 60_000);

describe('GET /api/dashboard recurrentes en Próximos pagos y deudas', () => {
  it('RF-M8-09 un recurrente de gasto que vence en 3 días aparece con RELEASE=1.2', async () => {
    const { cookie, userId } = await signedIn();
    const today = await todayOf(userId);
    const rule = await ruleDueOn(userId, today.in3);

    const res = await dashboard(today.month, cookie);

    expect(res.status).toBe(200);
    const found = itemsOf(bodyOf(res).upcoming, rule);
    expect(found).toHaveLength(1);
    expect(found[0]?.dueDate).toBe(today.in3);
    expect(found[0]?.name).toBe(rule.name);
  });

  it('RF-M8-09 con RELEASE=1.1 el mismo recurrente no aparece', async () => {
    const { cookie, userId } = await signedIn();
    const today = await todayOf(userId);
    const rule = await ruleDueOn(userId, today.in3);
    process.env['RELEASE'] = '1.1';

    const res = await dashboard(today.month, cookie);

    expect(res.status).toBe(200);
    expect(Array.isArray(bodyOf(res).upcoming)).toBe(true);
    expect(itemsOf(bodyOf(res).upcoming, rule)).toEqual([]);
  });

  it('RF-M8-09 un recurrente de transferencia que vence en 3 días aparece con RELEASE=1.2', async () => {
    const { cookie, userId } = await signedIn();
    const today = await todayOf(userId);
    const rule = await ruleDueOn(userId, today.in3, 'transfer');

    const res = await dashboard(today.month, cookie);

    expect(res.status).toBe(200);
    const found = itemsOf(bodyOf(res).upcoming, rule);
    expect(found.map((item) => item.dueDate)).toEqual([today.in3]);
  });

  it('RF-M8-09 un recurrente que vence en 8 días no aparece', async () => {
    const { cookie, userId } = await signedIn();
    const today = await todayOf(userId);
    const near = await ruleDueOn(userId, today.in3);
    const late = await ruleDueOn(userId, today.in8);

    const res = await dashboard(today.month, cookie);

    expect(res.status).toBe(200);
    expect(itemsOf(bodyOf(res).upcoming, near)).toHaveLength(1);
    expect(itemsOf(bodyOf(res).upcoming, late)).toEqual([]);
  });

  it('RNF-14 el usuario B nunca ve los recurrentes de A en su Inicio', async () => {
    const a = await signedIn();
    const b = await signedIn();
    const today = await todayOf(a.userId);
    const rule = await ruleDueOn(a.userId, today.in3);

    const ofA = bodyOf(await dashboard(today.month, a.cookie)).upcoming;
    expect(itemsOf(ofA, rule)).toHaveLength(1);
    const ofB = bodyOf(await dashboard(today.month, b.cookie)).upcoming;
    expect(itemsOf(ofB, rule)).toEqual([]);
  });
});

describe('preferencia de aviso de pendientes', () => {
  it('RF-M15-03 con el aviso de pendientes desactivado el pendiente sigue en Recurrentes', async () => {
    const { cookie, userId } = await signedIn();
    const today = await todayOf(userId);
    await db.$executeRaw`
      UPDATE notification_preference SET enabled = false
       WHERE user_id = ${userId}::uuid AND type = 'recurring_pending'`;
    const account = await createAccount(userId, {
      initialBalance: '500.00',
      initialBalanceDate: '2020-01-01',
    });
    const category = await createCategory(userId, { kind: 'expense' });
    const ruleId = uuidv7();

    const created = await request(app)
      .post('/api/recurring')
      .set('Origin', WEB_ORIGIN)
      .set('Cookie', cookie)
      .send({
        id: ruleId,
        name: uniqueRuleName('Pendiente'),
        kind: 'expense',
        amount: '40.00',
        accountId: account.id,
        categoryId: category.id,
        frequency: { type: 'daily' },
        startDate: today.today,
        end: { type: 'none' },
        mode: 'confirm',
      });
    expect(created.status, created.text).toBe(201);

    const overview = await request(app).get('/api/recurring').set('Cookie', cookie);
    expect(overview.status).toBe(200);
    const { pending } = overview.body as RecurringOverviewDto;
    expect(pending.filter((p) => p.ruleId === ruleId).map((p) => p.date)).toEqual([today.today]);

    const notices = await request(app).get('/api/notifications?limit=50').set('Cookie', cookie);
    expect(notices.status).toBe(200);
    const { items } = notices.body as { items: NotificationDto[] };
    expect(items.filter((n) => n.type === 'recurring_pending')).toEqual([]);
  });
});
