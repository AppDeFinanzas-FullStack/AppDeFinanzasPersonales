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
  systemCategoryId,
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

interface Problem {
  code?: string;
  status?: number;
  budgetId?: string;
}
const problem = (res: { body: unknown }) => res.body as Problem;

interface BudgetBody {
  id: string;
  amount: string;
  currencyCode: string;
  startDay: number;
  nextStartDay?: number;
  defaultAction: string;
  thresholds: number[];
  status: string;
  current?: { periodId: string; start: string; end: string; spent: string };
  periods?: { id: string }[];
}
const budgetOf = (res: { body: unknown }) => res.body as BudgetBody;

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

const expectSuccess = (res: { status: number }) => {
  expect(res.status).toBeGreaterThanOrEqual(200);
  expect(res.status).toBeLessThan(300);
};

const newBudgetBody = (categoryId: string, over: Record<string, unknown> = {}) => ({
  id: uuidv7(),
  scope: 'category',
  categoryId,
  amount: '500.00',
  currencyCode: 'BOB',
  ...over,
});

const countBudgets = async (userId: string) =>
  Number(
    (
      await db.$queryRaw<{ n: bigint }[]>`
        SELECT count(*) AS n FROM budget WHERE user_id = ${userId}::uuid`
    )[0]?.n ?? 0,
  );

interface Months {
  prevStart: string;
  prevEnd: string;
  curStart: string;
  curEnd: string;
}

/** The previous and the current calendar month in the timezone of the user. */
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

interface Closed {
  budget: TestBudget;
  periodId: string;
}

/**
 * A budget of 500.00 BOB, without spending, whose previous month is `closed_pending` (a surplus
 * of 500.00) and whose current month is open.
 */
async function closedBudget(userId: string, categoryId: string | null): Promise<Closed> {
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

const periodStatusOf = async (periodId: string) =>
  (
    await db.$queryRaw<{ status: string }[]>`
      SELECT status::text AS status FROM budget_period WHERE id = ${periodId}::uuid`
  )[0]?.status;

const decisionPath = (c: Closed) => `/api/budgets/${c.budget.id}/periods/${c.periodId}/decision`;

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
}, 60_000);

describe('release gate and session', () => {
  it('RF-M2-03 con RELEASE=1.0 las rutas de presupuestos responden 404 RELEASE_NOT_AVAILABLE', async () => {
    const { cookie, userId } = await signedIn();
    const category = await createCategory(userId);
    const closed = await closedBudget(userId, null);
    process.env['RELEASE'] = '1.0';
    const attempts: [string, Method, string, object | undefined][] = [
      ['GET', 'get', '/api/budgets', undefined],
      ['GET :id', 'get', `/api/budgets/${closed.budget.id}`, undefined],
      ['POST', 'post', '/api/budgets', newBudgetBody(category.id)],
      ['PATCH', 'patch', `/api/budgets/${closed.budget.id}`, { amount: '1.00' }],
      ['pause', 'post', `/api/budgets/${closed.budget.id}/pause`, undefined],
      ['resume', 'post', `/api/budgets/${closed.budget.id}/resume`, undefined],
      ['reset', 'post', `/api/budgets/${closed.budget.id}/reset-carryover`, undefined],
      [
        'decision',
        'post',
        decisionPath(closed),
        { result: 'surplus', carry: '0.00', discard: '500.00' },
      ],
      ['DELETE', 'delete', `/api/budgets/${closed.budget.id}`, undefined],
    ];
    for (const [label, method, path, body] of attempts) {
      const res = await call(method, path, cookie, body);
      expect(res.status, label).toBe(404);
      expect(problem(res).code, label).toBe('RELEASE_NOT_AVAILABLE');
    }
    expect(await countBudgets(userId)).toBe(1);
    expect(await periodStatusOf(closed.periodId)).toBe('closed_pending');
  });

  it('TASK-204 sin sesión responde 401', async () => {
    expect((await call('get', '/api/budgets', null)).status).toBe(401);
    expect((await call('post', '/api/budgets', null, newBudgetBody(uuidv7()))).status).toBe(401);
  });
});

describe('GET /api/budgets y GET /api/budgets/:id', () => {
  it('TASK-204 la lista trae los presupuestos del usuario con el período en curso', async () => {
    const { cookie, userId } = await signedIn();
    const category = await createCategory(userId);
    const body = newBudgetBody(category.id);
    expectSuccess(await call('post', '/api/budgets', cookie, body));
    const list = await call('get', '/api/budgets', cookie);
    expect(list.status).toBe(200);
    expect(JSON.stringify(list.body)).toContain(body.id);
  });

  it('TASK-204 el detalle trae el presupuesto, su período en curso y los 12 últimos períodos', async () => {
    const { cookie, userId } = await signedIn();
    const budget = await createBudget(userId, { categoryId: (await createCategory(userId)).id });
    const created: string[] = [];
    for (let year = 2000; year < 2014; year += 1) {
      const period = await createBudgetPeriod(userId, budget, {
        startDate: `${String(year)}-01-01`,
        endDate: `${String(year)}-01-31`,
        status: 'decided',
      });
      created.push(period.id);
    }
    const res = await call('get', `/api/budgets/${budget.id}`, cookie);
    expect(res.status).toBe(200);
    const detail = budgetOf(res);
    expect(detail.id).toBe(budget.id);
    expect(detail.amount).toBe('500.00');
    expect(detail.periods).toHaveLength(12);
    expect(new Set((detail.periods ?? []).map((p) => p.id))).toEqual(new Set(created.slice(2)));
  });

  it('TASK-204 GET de un presupuesto inexistente responde 404', async () => {
    const { cookie } = await signedIn();
    expect((await call('get', `/api/budgets/${uuidv7()}`, cookie)).status).toBe(404);
  });
});

describe('POST /api/budgets', () => {
  it('TASK-204 crea un presupuesto de categoría con su período en curso', async () => {
    const { cookie, userId } = await signedIn();
    const category = await createCategory(userId);
    const body = newBudgetBody(category.id);
    const res = await call('post', '/api/budgets', cookie, body);
    expectSuccess(res);
    const budget = budgetOf(res);
    expect(budget.id).toBe(body.id);
    expect(budget.amount).toBe('500.00');
    expect(budget.status).toBe('active');
    expect(budget.current?.periodId).toBeDefined();
    const one = await call('get', `/api/budgets/${body.id}`, cookie);
    expect(one.status).toBe(200);
  });

  it('TASK-204 crea un presupuesto general', async () => {
    const { cookie } = await signedIn();
    const res = await call('post', '/api/budgets', cookie, {
      id: uuidv7(),
      scope: 'general',
      amount: '3000.00',
      currencyCode: 'BOB',
    });
    expectSuccess(res);
    expect(budgetOf(res).amount).toBe('3000.00');
  });

  it('TASK-204 dos POST con el mismo id dejan una fila', async () => {
    const { cookie, userId } = await signedIn();
    const body = newBudgetBody((await createCategory(userId)).id);
    expectSuccess(await call('post', '/api/budgets', cookie, body));
    expectSuccess(await call('post', '/api/budgets', cookie, body));
    expect(await countBudgets(userId)).toBe(1);
  });

  it('TASK-204 un cuerpo inválido responde 400 VALIDATION_ERROR', async () => {
    const { cookie, userId } = await signedIn();
    const body = newBudgetBody((await createCategory(userId)).id, { amount: 'abc' });
    const res = await call('post', '/api/budgets', cookie, body);
    expect(res.status).toBe(400);
    expect(problem(res).code).toBe('VALIDATION_ERROR');
  });

  it('EC-M11-06 un segundo presupuesto de la misma categoría responde 409 BUDGET_EXISTS con budgetId', async () => {
    const { cookie, userId } = await signedIn();
    const category = await createCategory(userId);
    const existing = await createBudget(userId, { categoryId: category.id });
    const res = await call('post', '/api/budgets', cookie, newBudgetBody(category.id));
    expect(res.status).toBe(409);
    expect(problem(res).code).toBe('BUDGET_EXISTS');
    expect(problem(res).budgetId).toBe(existing.id);
  });

  it('TASK-204 "Deudas y préstamos" responde 422 CATEGORY_NOT_BUDGETABLE', async () => {
    const { cookie, userId } = await signedIn();
    const debts = await systemCategoryId(userId, 'debts');
    const res = await call('post', '/api/budgets', cookie, newBudgetBody(debts));
    expect(res.status).toBe(422);
    expect(problem(res).code).toBe('CATEGORY_NOT_BUDGETABLE');
  });

  it('TASK-204 "Intereses" se acepta', async () => {
    const { cookie, userId } = await signedIn();
    const interest = await systemCategoryId(userId, 'debts_interest');
    expectSuccess(await call('post', '/api/budgets', cookie, newBudgetBody(interest)));
  });

  it('TASK-204 una categoría de ingreso responde 422 CATEGORY_NOT_BUDGETABLE', async () => {
    const { cookie, userId } = await signedIn();
    const income = await createCategory(userId, { kind: 'income' });
    const res = await call('post', '/api/budgets', cookie, newBudgetBody(income.id));
    expect(res.status).toBe(422);
    expect(problem(res).code).toBe('CATEGORY_NOT_BUDGETABLE');
  });

  it('TASK-204 con 100 presupuestos el 101 responde 409 LIMIT_REACHED', async () => {
    const { cookie, userId } = await signedIn();
    for (let i = 0; i < 100; i += 1) {
      await createBudget(userId, { categoryId: (await createCategory(userId)).id });
    }
    const res = await call(
      'post',
      '/api/budgets',
      cookie,
      newBudgetBody((await createCategory(userId)).id),
    );
    expect(res.status).toBe(409);
    expect(problem(res).code).toBe('LIMIT_REACHED');
    expect(await countBudgets(userId)).toBe(100);
  }, 60_000);
});

describe('PATCH /api/budgets/:id', () => {
  it('TASK-204 edita el monto, la acción y los umbrales', async () => {
    const { cookie, userId } = await signedIn();
    const body = newBudgetBody((await createCategory(userId)).id);
    expectSuccess(await call('post', '/api/budgets', cookie, body));
    const res = await call('patch', `/api/budgets/${body.id}`, cookie, {
      amount: '750.00',
      defaultAction: 'carry',
      thresholds: [50, 90],
    });
    expectSuccess(res);
    const budget = budgetOf(res);
    expect(budget.amount).toBe('750.00');
    expect(budget.defaultAction).toBe('carry');
    expect(budget.thresholds).toEqual([50, 90]);
  });

  it('TASK-204 startDay se guarda como nextStartDay y la respuesta trae el fin del período', async () => {
    const { cookie, userId } = await signedIn();
    const body = newBudgetBody((await createCategory(userId)).id);
    const created = await call('post', '/api/budgets', cookie, body);
    expectSuccess(created);
    const before = budgetOf(created).current?.end ?? '';
    const res = await call('patch', `/api/budgets/${body.id}`, cookie, { startDay: 15 });
    expectSuccess(res);
    const budget = budgetOf(res);
    expect(budget.nextStartDay).toBe(15);
    expect(budget.current?.end).toMatch(/^\d{4}-\d{2}-14$/);
    expect((budget.current?.end ?? '') > before).toBe(true);
    const rows = await db.$queryRaw<{ next: number | null }[]>`
      SELECT next_start_day::int AS next FROM budget WHERE id = ${body.id}::uuid`;
    expect(rows[0]?.next).toBe(15);
  });

  it('TASK-204 cambiar la moneda responde 422 CURRENCY_IMMUTABLE', async () => {
    const { cookie, userId } = await signedIn();
    const budget = await createBudget(userId, { categoryId: (await createCategory(userId)).id });
    const res = await call('patch', `/api/budgets/${budget.id}`, cookie, { currencyCode: 'USD' });
    expect(res.status).toBe(422);
    expect(problem(res).code).toBe('CURRENCY_IMMUTABLE');
  });

  it('TASK-204 un presupuesto inexistente responde 404', async () => {
    const { cookie } = await signedIn();
    const res = await call('patch', `/api/budgets/${uuidv7()}`, cookie, { amount: '1.00' });
    expect(res.status).toBe(404);
  });
});

describe('pause, resume, reset-carryover, delete', () => {
  it('TASK-204 pausa y reanuda un presupuesto', async () => {
    const { cookie, userId } = await signedIn();
    const body = newBudgetBody((await createCategory(userId)).id);
    expectSuccess(await call('post', '/api/budgets', cookie, body));
    expectSuccess(await call('post', `/api/budgets/${body.id}/pause`, cookie));
    expect(budgetOf(await call('get', `/api/budgets/${body.id}`, cookie)).status).toBe('paused');
    expectSuccess(await call('post', `/api/budgets/${body.id}/resume`, cookie));
    expect(budgetOf(await call('get', `/api/budgets/${body.id}`, cookie)).status).toBe('active');
  });

  it('TASK-204 pausar un presupuesto ya pausado responde 409 INVALID_STATE', async () => {
    const { cookie, userId } = await signedIn();
    const budget = await createBudget(userId, {
      categoryId: (await createCategory(userId)).id,
      status: 'paused',
    });
    const res = await call('post', `/api/budgets/${budget.id}/pause`, cookie);
    expect(res.status).toBe(409);
    expect(problem(res).code).toBe('INVALID_STATE');
  });

  it('TASK-204 reanudar un presupuesto activo responde 409 INVALID_STATE', async () => {
    const { cookie, userId } = await signedIn();
    const body = newBudgetBody((await createCategory(userId)).id);
    expectSuccess(await call('post', '/api/budgets', cookie, body));
    const res = await call('post', `/api/budgets/${body.id}/resume`, cookie);
    expect(res.status).toBe(409);
    expect(problem(res).code).toBe('INVALID_STATE');
  });

  it('TASK-204 reiniciar el arrastre deja el carryover del período en curso en 0', async () => {
    const { cookie, userId } = await signedIn();
    const months = await monthsOf(userId);
    const budget = await createBudget(userId, { categoryId: (await createCategory(userId)).id });
    const current = await createBudgetPeriod(userId, budget, {
      startDate: months.curStart,
      endDate: months.curEnd,
      carryoverIn: '40.00',
    });
    expectSuccess(await call('post', `/api/budgets/${budget.id}/reset-carryover`, cookie));
    const rows = await db.$queryRaw<{ carry: string }[]>`
      SELECT carryover_in::text AS carry FROM budget_period WHERE id = ${current.id}::uuid`;
    expect(Number(rows[0]?.carry)).toBe(0);
  });

  it('TASK-204 elimina un presupuesto con su historia', async () => {
    const { cookie, userId } = await signedIn();
    const closed = await closedBudget(userId, (await createCategory(userId)).id);
    expectSuccess(await call('delete', `/api/budgets/${closed.budget.id}`, cookie));
    expect(await countBudgets(userId)).toBe(0);
    expect(await periodStatusOf(closed.periodId)).toBeUndefined();
    expect((await call('get', `/api/budgets/${closed.budget.id}`, cookie)).status).toBe(404);
  });
});

describe('POST /api/budgets/:id/periods/:periodId/decision', () => {
  it('TASK-204 decide un sobrante y el período queda decidido', async () => {
    const { cookie, userId } = await signedIn();
    const closed = await closedBudget(userId, (await createCategory(userId)).id);
    const res = await call('post', decisionPath(closed), cookie, {
      result: 'surplus',
      carry: '0.00',
      discard: '500.00',
    });
    expectSuccess(res);
    expect(await periodStatusOf(closed.periodId)).toBe('decided');
  });

  it('TASK-204 una segunda decisión responde 409 DECISION_ALREADY_MADE', async () => {
    const { cookie, userId } = await signedIn();
    const closed = await closedBudget(userId, (await createCategory(userId)).id);
    const input = { result: 'surplus', carry: '0.00', discard: '500.00' };
    expectSuccess(await call('post', decisionPath(closed), cookie, input));
    const res = await call('post', decisionPath(closed), cookie, input);
    expect(res.status).toBe(409);
    expect(problem(res).code).toBe('DECISION_ALREADY_MADE');
  });

  it('TASK-204 un reparto que no suma el sobrante responde 422 SPLIT_MISMATCH', async () => {
    const { cookie, userId } = await signedIn();
    const closed = await closedBudget(userId, (await createCategory(userId)).id);
    const res = await call('post', decisionPath(closed), cookie, {
      result: 'surplus',
      carry: '0.00',
      discard: '100.00',
    });
    expect(res.status).toBe(422);
    expect(problem(res).code).toBe('SPLIT_MISMATCH');
    expect(await periodStatusOf(closed.periodId)).toBe('closed_pending');
  });

  it('TASK-204 enviar a meta desde una subcategoría responde 422 TO_GOAL_NOT_ALLOWED', async () => {
    const { cookie, userId } = await signedIn();
    const parent = await createCategory(userId);
    const child = await createCategory(userId, { parentId: parent.id });
    const closed = await closedBudget(userId, child.id);
    const goal = await createGoal(userId);
    const bank = await createAccount(userId, { initialBalance: '1000.00' });
    const res = await call('post', decisionPath(closed), cookie, {
      result: 'surplus',
      carry: '0.00',
      discard: '400.00',
      toGoal: { goalId: goal.id, accountId: bank.id, amount: '100.00', mode: 'earmark' },
    });
    expect(res.status).toBe(422);
    expect(problem(res).code).toBe('TO_GOAL_NOT_ALLOWED');
  });

  it('TASK-204 enviar a meta más que el saldo libre responde 422 EARMARK_EXCEEDS_FREE', async () => {
    const { cookie, userId } = await signedIn();
    const closed = await closedBudget(userId, null);
    const goal = await createGoal(userId);
    const bank = await createAccount(userId, { initialBalance: '10.00' });
    const res = await call('post', decisionPath(closed), cookie, {
      result: 'surplus',
      carry: '0.00',
      discard: '400.00',
      toGoal: { goalId: goal.id, accountId: bank.id, amount: '100.00', mode: 'earmark' },
    });
    expect(res.status).toBe(422);
    expect(problem(res).code).toBe('EARMARK_EXCEEDS_FREE');
    expect(await periodStatusOf(closed.periodId)).toBe('closed_pending');
  });

  it('TASK-204 enviar a una meta archivada responde 409 GOAL_NOT_AVAILABLE', async () => {
    const { cookie, userId } = await signedIn();
    const closed = await closedBudget(userId, null);
    const goal = await createGoal(userId);
    await db.$executeRaw`UPDATE goal SET archived_at = now() WHERE id = ${goal.id}::uuid`;
    const bank = await createAccount(userId, { initialBalance: '1000.00' });
    const res = await call('post', decisionPath(closed), cookie, {
      result: 'surplus',
      carry: '0.00',
      discard: '400.00',
      toGoal: { goalId: goal.id, accountId: bank.id, amount: '100.00', mode: 'earmark' },
    });
    expect(res.status).toBe(409);
    expect(problem(res).code).toBe('GOAL_NOT_AVAILABLE');
  });

  it('TASK-204 un cuerpo de decisión inválido responde 400 VALIDATION_ERROR', async () => {
    const { cookie, userId } = await signedIn();
    const closed = await closedBudget(userId, (await createCategory(userId)).id);
    const res = await call('post', decisionPath(closed), cookie, { result: 'otro' });
    expect(res.status).toBe(400);
    expect(problem(res).code).toBe('VALIDATION_ERROR');
  });
});
