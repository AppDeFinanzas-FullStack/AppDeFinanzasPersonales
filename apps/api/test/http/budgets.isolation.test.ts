import type { Express } from 'express';
import request from 'supertest';
import { uuidv7 } from 'uuidv7';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { buildContainer, createApp, type Container } from '../../src/composition/container.js';
import { parseEnv } from '../../src/infrastructure/config/env.js';
import { createAccount } from '../factories/account.factory.js';
import {
  createBudget,
  createBudgetPeriod,
  deleteBudgetsOf,
  type TestBudget,
} from '../factories/budget.factory.js';
import { createCategory } from '../factories/category.factory.js';
import { createGoal, deleteGoalsOf } from '../factories/goal.factory.js';
import { disconnectTestPrisma, testPrisma } from '../integration/setup/db.js';

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

interface Account {
  cookie: string;
  userId: string;
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

type Method = 'get' | 'post' | 'patch' | 'delete';
const call = (method: Method, path: string, cookie: string | null, body?: object) => {
  const req = request(app)[method](path);
  if (method !== 'get') req.set('Origin', WEB_ORIGIN);
  if (cookie !== null) req.set('Cookie', cookie);
  return method === 'get' || method === 'delete' ? req : req.send(body ?? {});
};

interface Months {
  prevStart: string;
  prevEnd: string;
  curStart: string;
  curEnd: string;
}

async function monthsOf(userId: string): Promise<Months> {
  const rows = await db.$queryRaw<Months[]>`
    SELECT to_char(date_trunc('month', d) - interval '1 month', 'YYYY-MM-DD') AS "prevStart",
           to_char(date_trunc('month', d) - interval '1 day', 'YYYY-MM-DD') AS "prevEnd",
           to_char(date_trunc('month', d), 'YYYY-MM-DD') AS "curStart",
           to_char(date_trunc('month', d) + interval '1 month' - interval '1 day', 'YYYY-MM-DD')
             AS "curEnd"
      FROM (SELECT (now() AT TIME ZONE timezone)::date AS d
              FROM auth_user WHERE id = ${userId}::uuid) t`;
  const months = rows[0];
  if (months === undefined) throw new Error('the user has no timezone');
  return months;
}

/** A budget of 500.00 BOB whose previous month is `closed_pending` and current month open. */
async function closedBudget(
  userId: string,
  categoryId: string | null,
): Promise<{ budget: TestBudget; periodId: string }> {
  const months = await monthsOf(userId);
  const budget = await createBudget(userId, { categoryId, amount: '500.00' });
  const prev = await createBudgetPeriod(userId, budget, {
    startDate: months.prevStart,
    endDate: months.prevEnd,
    status: 'closed_pending',
  });
  await createBudgetPeriod(userId, budget, {
    startDate: months.curStart,
    endDate: months.curEnd,
  });
  return { budget, periodId: prev.id };
}

interface BudgetRow {
  amount: string;
  status: string;
  periodStatus: string;
}

const stateOf = async (budgetId: string, periodId: string) =>
  (
    await db.$queryRaw<BudgetRow[]>`
      SELECT b.amount::text AS amount, b.status::text AS status,
             p.status::text AS "periodStatus"
        FROM budget b JOIN budget_period p ON p.budget_id = b.id
       WHERE b.id = ${budgetId}::uuid AND p.id = ${periodId}::uuid`
  )[0];

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
  await sleep(300);
  await deleteBudgetsOf(usedUsers);
  await deleteGoalsOf(usedUsers);
  await db.$executeRaw`DELETE FROM auth_user WHERE email = ANY(${usedEmails}::text[])`;
  await db.$executeRaw`DELETE FROM email_outbox WHERE to_address = ANY(${usedEmails}::text[])`;
  await disconnectTestPrisma();
  await container.prisma.$disconnect();
}, 30_000);

describe('aislamiento de presupuestos entre usuarios', () => {
  it('RNF-14 GET /api/budgets no lista los presupuestos de otro usuario', async () => {
    const a = await signedIn();
    const b = await signedIn();
    const budget = await createBudget(a.userId, {
      categoryId: (await createCategory(a.userId)).id,
    });
    const res = await call('get', '/api/budgets', b.cookie);
    expect(res.status).toBe(200);
    expect(JSON.stringify(res.body)).not.toContain(budget.id);
  });

  it('RNF-14 el usuario B recibe 404 en cada endpoint con un presupuesto de A', async () => {
    const a = await signedIn();
    const b = await signedIn();
    const closed = await closedBudget(a.userId, (await createCategory(a.userId)).id);
    const id = closed.budget.id;
    const attempts: [string, Method, string, object | undefined][] = [
      ['GET :id', 'get', `/api/budgets/${id}`, undefined],
      ['PATCH', 'patch', `/api/budgets/${id}`, { amount: '1.00' }],
      ['pause', 'post', `/api/budgets/${id}/pause`, undefined],
      ['resume', 'post', `/api/budgets/${id}/resume`, undefined],
      ['reset-carryover', 'post', `/api/budgets/${id}/reset-carryover`, undefined],
      [
        'decision',
        'post',
        `/api/budgets/${id}/periods/${closed.periodId}/decision`,
        { result: 'surplus', carry: '0.00', discard: '500.00' },
      ],
      ['DELETE', 'delete', `/api/budgets/${id}`, undefined],
    ];
    for (const [label, method, path, body] of attempts) {
      const res = await call(method, path, b.cookie, body);
      expect(res.status, label).toBe(404);
    }
    const state = await stateOf(id, closed.periodId);
    expect(state?.amount).toBe('500.00');
    expect(state?.status).toBe('active');
    expect(state?.periodStatus).toBe('closed_pending');
  });

  it('RNF-14 B no decide un período de A desde un presupuesto propio: 404', async () => {
    const a = await signedIn();
    const b = await signedIn();
    const closedA = await closedBudget(a.userId, (await createCategory(a.userId)).id);
    const closedB = await closedBudget(b.userId, (await createCategory(b.userId)).id);
    const res = await call(
      'post',
      `/api/budgets/${closedB.budget.id}/periods/${closedA.periodId}/decision`,
      b.cookie,
      { result: 'surplus', carry: '0.00', discard: '500.00' },
    );
    expect(res.status).toBe(404);
    expect((await stateOf(closedA.budget.id, closedA.periodId))?.periodStatus).toBe(
      'closed_pending',
    );
  });

  it('RNF-14 B no envía a una meta de A (como inexistente, GOAL_NOT_AVAILABLE) ni desde una cuenta de A (404) al decidir', async () => {
    const a = await signedIn();
    const b = await signedIn();
    const goalA = await createGoal(a.userId);
    const accA = await createAccount(a.userId, { initialBalance: '1000.00' });
    const goalB = await createGoal(b.userId);
    const accB = await createAccount(b.userId, { initialBalance: '1000.00' });
    const closedB = await closedBudget(b.userId, null);
    const path = `/api/budgets/${closedB.budget.id}/periods/${closedB.periodId}/decision`;
    const withGoalA = await call('post', path, b.cookie, {
      result: 'surplus',
      carry: '0.00',
      discard: '400.00',
      toGoal: { goalId: goalA.id, accountId: accB.id, amount: '100.00', mode: 'earmark' },
    });
    expect(withGoalA.status).toBe(409);
    expect((withGoalA.body as { code?: string }).code).toBe('GOAL_NOT_AVAILABLE');
    const withAccA = await call('post', path, b.cookie, {
      result: 'surplus',
      carry: '0.00',
      discard: '400.00',
      toGoal: { goalId: goalB.id, accountId: accA.id, amount: '100.00', mode: 'earmark' },
    });
    expect(withAccA.status).toBe(404);
    const rows = await db.$queryRaw<{ n: bigint }[]>`
      SELECT count(*) AS n FROM goal_allocation_event
       WHERE goal_id = ${goalA.id}::uuid OR account_id = ${accA.id}::uuid`;
    expect(Number(rows[0]?.n)).toBe(0);
  });

  it('RNF-14 B no crea un presupuesto con una categoría de A: 404', async () => {
    const a = await signedIn();
    const b = await signedIn();
    const categoryA = await createCategory(a.userId);
    const res = await call('post', '/api/budgets', b.cookie, {
      id: uuidv7(),
      scope: 'category',
      categoryId: categoryA.id,
      amount: '500.00',
      currencyCode: 'BOB',
    });
    expect(res.status).toBe(404);
  });
});
