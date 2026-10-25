import type { DashboardDto } from '@finanzas/contracts';
import type { Express } from 'express';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { buildContainer, createApp, type Container } from '../../src/composition/container.js';
import { parseEnv } from '../../src/infrastructure/config/env.js';
import { createAccount } from '../factories/account.factory.js';
import { createBudget, createBudgetPeriod, deleteBudgetsOf } from '../factories/budget.factory.js';
import { createCategory } from '../factories/category.factory.js';
import { createLedgerTransaction, deleteLedgerOf } from '../factories/ledger.factory.js';
import { disconnectTestPrisma, testPrisma } from '../integration/setup/db.js';

/**
 * `GET /api/dashboard?month` block `budgets` (plan §4.8.1, RF-M8-08): one bar per active budget in
 * the current month; in a past month, the periods that ended inside it. Only with RELEASE >= 1.1.
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
  RELEASE: '1.1',
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

interface CurrentMonth {
  month: string;
  start: string;
  end: string;
}

/** The current calendar month in the timezone of the user. */
async function currentMonthOf(userId: string): Promise<CurrentMonth> {
  const rows = await db.$queryRaw<CurrentMonth[]>`
    SELECT to_char(date_trunc('month', d), 'YYYY-MM') AS month,
           to_char(date_trunc('month', d), 'YYYY-MM-DD') AS start,
           to_char(date_trunc('month', d) + interval '1 month' - interval '1 day', 'YYYY-MM-DD')
             AS "end"
      FROM (SELECT (now() AT TIME ZONE timezone)::date AS d
              FROM auth_user WHERE id = ${userId}::uuid) t`;
  const found = rows[0];
  if (found === undefined) throw new Error('the user has no timezone');
  return found;
}

beforeAll(async () => {
  process.env['RELEASE'] = '1.1';
  container = await Promise.resolve(buildContainer(parseEnv(envSource())));
  app = await Promise.resolve(createApp(container));
}, 30_000);

afterEach(() => {
  process.env['RELEASE'] = '1.1';
});

afterAll(async () => {
  if (originalRelease === undefined) delete process.env['RELEASE'];
  else process.env['RELEASE'] = originalRelease;
  await deleteBudgetsOf(usedUsers);
  await deleteLedgerOf(usedUsers);
  await db.$executeRaw`DELETE FROM auth_user WHERE email = ANY(${usedEmails}::text[])`;
  await db.$executeRaw`DELETE FROM email_outbox WHERE to_address = ANY(${usedEmails}::text[])`;
  await disconnectTestPrisma();
  await container.prisma.$disconnect();
}, 60_000);

describe('GET /api/dashboard bloque de presupuestos', () => {
  it('RF-M8-08 en el mes actual trae una barra por presupuesto activo', async () => {
    const { cookie, userId } = await signedIn();
    const now = await currentMonthOf(userId);
    const account = await createAccount(userId, { initialBalanceDate: '2020-01-01' });
    const category = await createCategory(userId, { kind: 'expense' });
    const other = await createCategory(userId, { kind: 'expense' });
    const active = await createBudget(userId, { categoryId: category.id, amount: '500.00' });
    await createBudgetPeriod(userId, active, { startDate: now.start, endDate: now.end });
    const paused = await createBudget(userId, {
      categoryId: other.id,
      amount: '300.00',
      status: 'paused',
    });
    await createBudgetPeriod(userId, paused, { startDate: now.start, endDate: now.end });
    await createLedgerTransaction(userId, {
      kind: 'expense',
      date: now.start,
      categoryId: category.id,
      entries: [{ accountId: account.id, amount: '-200.00' }],
    });

    const res = await dashboard(now.month, cookie);

    expect(res.status).toBe(200);
    const { budgets } = bodyOf(res);
    expect(budgets).toHaveLength(1);
    expect(budgets?.[0]?.categoryId).toBe(category.id);
    expect(budgets?.[0]?.limit).toBe('500.00');
    expect(budgets?.[0]?.spent).toBe('200.00');
  });

  it('RF-M8-08 en un mes pasado trae el período que cerró en él', async () => {
    const { cookie, userId } = await signedIn();
    const category = await createCategory(userId, { kind: 'expense' });
    const budget = await createBudget(userId, { categoryId: category.id, amount: '400.00' });
    await createBudgetPeriod(userId, budget, {
      startDate: '2025-03-01',
      endDate: '2025-03-31',
      status: 'decided',
    });
    await createBudgetPeriod(userId, budget, {
      startDate: '2025-04-01',
      endDate: '2025-04-30',
      status: 'decided',
    });

    const march = bodyOf(await dashboard('2025-03', cookie));
    expect(march.budgets).toHaveLength(1);
    expect(march.budgets?.[0]?.categoryId).toBe(category.id);
    expect(march.budgets?.[0]?.limit).toBe('400.00');

    const feb = bodyOf(await dashboard('2025-02', cookie));
    expect(feb.budgets).toEqual([]);
  });

  it('RF-M8-08 sin presupuestos el bloque viene vacío', async () => {
    const { cookie, userId } = await signedIn();
    const now = await currentMonthOf(userId);

    const res = await dashboard(now.month, cookie);

    expect(res.status).toBe(200);
    expect(bodyOf(res).budgets).toEqual([]);
  });

  it('RF-M8-08 con RELEASE=1.0 el bloque no viene en la respuesta', async () => {
    const { cookie, userId } = await signedIn();
    const now = await currentMonthOf(userId);
    const category = await createCategory(userId, { kind: 'expense' });
    const budget = await createBudget(userId, { categoryId: category.id });
    await createBudgetPeriod(userId, budget, { startDate: now.start, endDate: now.end });
    process.env['RELEASE'] = '1.0';

    const res = await dashboard(now.month, cookie);

    expect(res.status).toBe(200);
    expect(res.body).not.toHaveProperty('budgets');
  });

  it('RF-M8-10 un bloque de presupuestos oculto no viene en la respuesta', async () => {
    const { cookie, userId } = await signedIn();
    const now = await currentMonthOf(userId);
    const settings = await request(app).get('/api/settings').set('Cookie', cookie);
    expect(settings.status).toBe(200);
    const current = (settings.body as { dashboardBlocks: { key: string; visible: boolean }[] })
      .dashboardBlocks;
    const patch = await request(app)
      .patch('/api/settings')
      .set('Origin', WEB_ORIGIN)
      .set('Cookie', cookie)
      .send({
        dashboardBlocks: current.map((b) => (b.key === 'budget' ? { ...b, visible: false } : b)),
      });
    expect(patch.status).toBe(200);

    const res = await dashboard(now.month, cookie);

    expect(res.status).toBe(200);
    expect(res.body).not.toHaveProperty('budgets');
  });

  it('RNF-14 el usuario B nunca ve los presupuestos de A', async () => {
    const a = await signedIn();
    const b = await signedIn();
    const now = await currentMonthOf(a.userId);
    const category = await createCategory(a.userId, { kind: 'expense' });
    const budget = await createBudget(a.userId, { categoryId: category.id });
    await createBudgetPeriod(a.userId, budget, { startDate: now.start, endDate: now.end });

    expect(bodyOf(await dashboard(now.month, a.cookie)).budgets).toHaveLength(1);
    expect(bodyOf(await dashboard(now.month, b.cookie)).budgets).toEqual([]);
  });
});
