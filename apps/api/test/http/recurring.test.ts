import type { Express } from 'express';
import request from 'supertest';
import { uuidv7 } from 'uuidv7';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { buildContainer, createApp, type Container } from '../../src/composition/container.js';
import { parseEnv } from '../../src/infrastructure/config/env.js';
import { createAccount, type TestAccountType } from '../factories/account.factory.js';
import { createCategory } from '../factories/category.factory.js';
import { createAllocationEvent, createGoal, deleteGoalsOf } from '../factories/goal.factory.js';
import { deleteLedgerOf } from '../factories/ledger.factory.js';
import {
  createOccurrence,
  createRule,
  deleteRecurringOf,
  occurrencesOf,
  occurrenceStatus,
} from '../factories/recurring.factory.js';
import { disconnectTestPrisma, testPrisma } from '../integration/setup/db.js';

/**
 * `/api/recurring` (plan §4.14.2), behind the release of M14 (V1.2, ADR-18). The rules and
 * occurrences are written by SQL with the factories; the users are signed in through the API and
 * keep the default timezone (`America/La_Paz`), so "today" is the local date there.
 */
const WEB_ORIGIN = 'http://localhost:5173';
const COOKIE_NAME = '__Secure-better-auth.session_token';
const TIMEZONE = 'America/La_Paz';

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

interface RuleBody {
  id: string;
  name: string;
  status: string;
}
const ruleOf = (res: { body: unknown }) => res.body as RuleBody;

interface OverviewBody {
  rules: unknown[];
  pending: unknown[];
  upcoming30: unknown[];
}
const overviewOf = (res: { body: unknown }) => res.body as OverviewBody;

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

/** Today in the timezone of the users of this file. */
const localToday = (): string =>
  new Intl.DateTimeFormat('en-CA', {
    timeZone: TIMEZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());

const addDays = (date: string, days: number): string =>
  new Date(Date.parse(`${date}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);

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

const expectSuccess = (res: { status: number; text: string }) => {
  expect(res.status, res.text).toBeGreaterThanOrEqual(200);
  expect(res.status, res.text).toBeLessThan(300);
};

/** A monthly expense rule of 150.00 in automatic mode that starts in 30 days. */
const newRuleBody = (
  accountId: string,
  categoryId: string,
  over: Record<string, unknown> = {},
) => ({
  id: uuidv7(),
  name: `Regla ${uuidv7().slice(-8)}`,
  kind: 'expense',
  amount: '150.00',
  accountId,
  categoryId,
  frequency: { type: 'monthly', day: 5 },
  startDate: addDays(localToday(), 30),
  end: { type: 'none' },
  mode: 'auto',
  ...over,
});

const countRules = async (userId: string) =>
  Number(
    (
      await db.$queryRaw<{ n: bigint }[]>`
        SELECT count(*) AS n FROM recurring_rule WHERE user_id = ${userId}::uuid`
    )[0]?.n ?? 0,
  );

const ruleRow = async (id: string) =>
  (
    await db.$queryRaw<{ name: string; status: string }[]>`
      SELECT name, status::text AS status FROM recurring_rule WHERE id = ${id}::uuid`
  )[0];

/**
 * A paused monthly rule in confirmation mode (no amount) with one skipped date three days ago: it
 * started 40 days ago and was paused 10 days ago.
 */
async function pausedRuleWithSkippedDate(userId: string) {
  const skippedDate = addDays(localToday(), -3);
  const rule = await createRule(userId, {
    amount: null,
    dayOfMonth: Number(skippedDate.slice(8, 10)),
    startDate: addDays(localToday(), -40),
    status: 'paused',
  });
  await db.$executeRaw`
    UPDATE recurring_rule SET paused_at = now() - interval '10 days' WHERE id = ${rule.id}::uuid`;
  return { rule, skippedDate };
}

/** An expense rule of 150.00 on an account with the given balance since 30 days ago. */
async function confirmableOccurrence(
  userId: string,
  initialBalance = '500.00',
  type: TestAccountType = 'bank',
) {
  const account = await createAccount(userId, {
    type,
    initialBalance,
    initialBalanceDate: addDays(localToday(), -30),
  });
  const rule = await createRule(userId, { accountId: account.id });
  const occurrence = await createOccurrence(userId, rule.id, {
    scheduledDate: addDays(localToday(), -2),
  });
  return { account, rule, occurrence };
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
  it('RF-M2-03 con RELEASE=1.1 las rutas de recurrentes responden 404 RELEASE_NOT_AVAILABLE', async () => {
    const { cookie, userId } = await signedIn();
    const rule = await createRule(userId);
    const occurrence = await createOccurrence(userId, rule.id);
    process.env['RELEASE'] = '1.1';
    const attempts: [Method, string, object | undefined][] = [
      ['get', '/api/recurring', undefined],
      ['post', '/api/recurring', newRuleBody(rule.accountId, rule.categoryId ?? uuidv7())],
      ['patch', `/api/recurring/${rule.id}`, { name: 'Otra' }],
      ['post', `/api/recurring/${rule.id}/pause`, undefined],
      ['get', `/api/recurring/${rule.id}/skipped`, undefined],
      ['post', `/api/recurring/${rule.id}/resume`, { registerDates: [] }],
      ['delete', `/api/recurring/${rule.id}`, undefined],
      ['post', `/api/recurring/occurrences/${occurrence.id}/confirm`, { transactionId: uuidv7() }],
      ['post', `/api/recurring/occurrences/${occurrence.id}/skip`, undefined],
    ];
    for (const [method, path, body] of attempts) {
      const res = await call(method, path, cookie, body);
      expect(res.status, `${method} ${path}`).toBe(404);
      expect(problem(res).code, `${method} ${path}`).toBe('RELEASE_NOT_AVAILABLE');
    }
    expect((await ruleRow(rule.id))?.status).toBe('active');
    expect(await occurrenceStatus(occurrence.id)).toBe('pending');
  });

  it('TASK-233 sin sesión responde 401', async () => {
    expect((await call('get', '/api/recurring', null)).status).toBe(401);
    expect((await call('post', '/api/recurring', null, {})).status).toBe(401);
    expect((await call('post', `/api/recurring/${uuidv7()}/pause`, null)).status).toBe(401);
    expect(
      (await call('post', `/api/recurring/occurrences/${uuidv7()}/skip`, null)).status,
    ).toBe(401);
  });
});

describe('GET /api/recurring', () => {
  it('TASK-233 devuelve las reglas, los pendientes y los vencimientos de 30 días', async () => {
    const { cookie, userId } = await signedIn();
    const rule = await createRule(userId);
    const occurrence = await createOccurrence(userId, rule.id);
    const res = await call('get', '/api/recurring', cookie);
    expect(res.status).toBe(200);
    const body = overviewOf(res);
    expect(Array.isArray(body.rules)).toBe(true);
    expect(Array.isArray(body.pending)).toBe(true);
    expect(Array.isArray(body.upcoming30)).toBe(true);
    expect(JSON.stringify(body.rules)).toContain(rule.id);
    expect(JSON.stringify(body.pending)).toContain(occurrence.id);
  });
});

describe('POST /api/recurring', () => {
  it('TASK-233 crea una regla y aparece en GET /api/recurring', async () => {
    const { cookie, userId } = await signedIn();
    const account = await createAccount(userId);
    const category = await createCategory(userId);
    const body = newRuleBody(account.id, category.id);
    const res = await call('post', '/api/recurring', cookie, body);
    expectSuccess(res);
    expect(ruleOf(res).id).toBe(body.id);
    expect(ruleOf(res).status).toBe('active');
    const list = await call('get', '/api/recurring', cookie);
    expect(list.status).toBe(200);
    expect(JSON.stringify(overviewOf(list).rules)).toContain(body.id);
  });

  it('TASK-233 dos POST con el mismo id dejan una fila', async () => {
    const { cookie, userId } = await signedIn();
    const account = await createAccount(userId);
    const category = await createCategory(userId);
    const body = newRuleBody(account.id, category.id);
    expectSuccess(await call('post', '/api/recurring', cookie, body));
    expectSuccess(await call('post', '/api/recurring', cookie, body));
    expect(await countRules(userId)).toBe(1);
  });

  it('TASK-233 una regla que empieza hoy genera la ocurrencia de hoy', async () => {
    const { cookie, userId } = await signedIn();
    const account = await createAccount(userId);
    const category = await createCategory(userId);
    const today = localToday();
    const body = newRuleBody(account.id, category.id, {
      amount: undefined,
      mode: 'confirm',
      frequency: { type: 'daily' },
      startDate: today,
    });
    expectSuccess(await call('post', '/api/recurring', cookie, body));
    const occurrences = await occurrencesOf(body.id);
    expect(occurrences.map((o) => o.scheduledDate)).toEqual([today]);
    expect(occurrences[0]?.status).toBe('pending');
  });

  it('TASK-233 en modo automático sin monto responde 422 AMOUNT_REQUIRED_FOR_AUTO', async () => {
    const { cookie, userId } = await signedIn();
    const account = await createAccount(userId);
    const category = await createCategory(userId);
    const res = await call(
      'post',
      '/api/recurring',
      cookie,
      newRuleBody(account.id, category.id, { amount: undefined, mode: 'auto' }),
    );
    expect(res.status).toBe(422);
    expect(problem(res).code).toBe('AMOUNT_REQUIRED_FOR_AUTO');
    expect(await countRules(userId)).toBe(0);
  });

  it('TASK-233 una fecha de inicio pasada responde 422 START_DATE_IN_PAST', async () => {
    const { cookie, userId } = await signedIn();
    const account = await createAccount(userId);
    const category = await createCategory(userId);
    const res = await call(
      'post',
      '/api/recurring',
      cookie,
      newRuleBody(account.id, category.id, { startDate: addDays(localToday(), -1) }),
    );
    expect(res.status).toBe(422);
    expect(problem(res).code).toBe('START_DATE_IN_PAST');
    expect(await countRules(userId)).toBe(0);
  });

  it('TASK-233 con 100 reglas la 101 responde 409 LIMIT_REACHED', async () => {
    const { cookie, userId } = await signedIn();
    const account = await createAccount(userId);
    const category = await createCategory(userId);
    for (let i = 0; i < 100; i += 1) {
      await createRule(userId, { accountId: account.id, categoryId: category.id });
    }
    const res = await call('post', '/api/recurring', cookie, newRuleBody(account.id, category.id));
    expect(res.status).toBe(409);
    expect(problem(res).code).toBe('LIMIT_REACHED');
    expect(await countRules(userId)).toBe(100);
  }, 60_000);

  it('TASK-233 un cuerpo inválido responde 400 VALIDATION_ERROR', async () => {
    const { cookie, userId } = await signedIn();
    const account = await createAccount(userId);
    const category = await createCategory(userId);
    const res = await call(
      'post',
      '/api/recurring',
      cookie,
      newRuleBody(account.id, category.id, { frequency: { type: 'hourly' } }),
    );
    expect(res.status).toBe(400);
    expect(problem(res).code).toBe('VALIDATION_ERROR');
  });
});

describe('PATCH /api/recurring/:id', () => {
  it('TASK-233 edita el nombre de la regla y el pendiente no cambia', async () => {
    const { cookie, userId } = await signedIn();
    const rule = await createRule(userId);
    const occurrence = await createOccurrence(userId, rule.id);
    const res = await call('patch', `/api/recurring/${rule.id}`, cookie, { name: 'Nuevo nombre' });
    expectSuccess(res);
    expect(ruleOf(res).name).toBe('Nuevo nombre');
    expect((await ruleRow(rule.id))?.name).toBe('Nuevo nombre');
    expect(await occurrenceStatus(occurrence.id)).toBe('pending');
  });

  it('TASK-233 un cuerpo inválido responde 400 VALIDATION_ERROR', async () => {
    const { cookie, userId } = await signedIn();
    const rule = await createRule(userId);
    const res = await call('patch', `/api/recurring/${rule.id}`, cookie, { amount: 'abc' });
    expect(res.status).toBe(400);
    expect(problem(res).code).toBe('VALIDATION_ERROR');
  });

  it('TASK-233 una regla inexistente responde 404', async () => {
    const { cookie } = await signedIn();
    const res = await call('patch', `/api/recurring/${uuidv7()}`, cookie, { name: 'X' });
    expect(res.status).toBe(404);
  });
});

describe('pause, skipped and resume', () => {
  it('TASK-233 pausa una regla activa', async () => {
    const { cookie, userId } = await signedIn();
    const rule = await createRule(userId);
    expectSuccess(await call('post', `/api/recurring/${rule.id}/pause`, cookie));
    expect((await ruleRow(rule.id))?.status).toBe('paused');
  });

  it('TASK-233 pausar una regla ya pausada responde 409 INVALID_STATE', async () => {
    const { cookie, userId } = await signedIn();
    const rule = await createRule(userId, { status: 'paused' });
    const res = await call('post', `/api/recurring/${rule.id}/pause`, cookie);
    expect(res.status).toBe(409);
    expect(problem(res).code).toBe('INVALID_STATE');
  });

  it('TASK-233 GET skipped devuelve las fechas saltadas durante la pausa', async () => {
    const { cookie, userId } = await signedIn();
    const { rule, skippedDate } = await pausedRuleWithSkippedDate(userId);
    const res = await call('get', `/api/recurring/${rule.id}/skipped`, cookie);
    expect(res.status).toBe(200);
    expect(JSON.stringify(res.body)).toContain(skippedDate);
  });

  it('TASK-233 reanudar registra la fecha saltada elegida y deja la regla activa', async () => {
    const { cookie, userId } = await signedIn();
    const { rule, skippedDate } = await pausedRuleWithSkippedDate(userId);
    const res = await call('post', `/api/recurring/${rule.id}/resume`, cookie, {
      registerDates: [skippedDate],
    });
    expectSuccess(res);
    expect((await ruleRow(rule.id))?.status).toBe('active');
    const dates = (await occurrencesOf(rule.id)).map((o) => o.scheduledDate);
    expect(dates).toContain(skippedDate);
  });

  it('TASK-233 reanudar con una fecha que no se saltó responde 422 DATE_NOT_SKIPPED', async () => {
    const { cookie, userId } = await signedIn();
    const { rule, skippedDate } = await pausedRuleWithSkippedDate(userId);
    const res = await call('post', `/api/recurring/${rule.id}/resume`, cookie, {
      registerDates: [addDays(skippedDate, 1)],
    });
    expect(res.status).toBe(422);
    expect(problem(res).code).toBe('DATE_NOT_SKIPPED');
    expect((await ruleRow(rule.id))?.status).toBe('paused');
  });

  it('TASK-233 reanudar una regla activa responde 409 INVALID_STATE', async () => {
    const { cookie, userId } = await signedIn();
    const rule = await createRule(userId);
    const res = await call('post', `/api/recurring/${rule.id}/resume`, cookie, {
      registerDates: [],
    });
    expect(res.status).toBe(409);
    expect(problem(res).code).toBe('INVALID_STATE');
  });

  it('TASK-233 reanudar sin registerDates responde 400 VALIDATION_ERROR', async () => {
    const { cookie, userId } = await signedIn();
    const rule = await createRule(userId, { status: 'paused' });
    const res = await call('post', `/api/recurring/${rule.id}/resume`, cookie, {});
    expect(res.status).toBe(400);
    expect(problem(res).code).toBe('VALIDATION_ERROR');
  });

  it('TASK-233 pause, skipped y resume de una regla inexistente responden 404', async () => {
    const { cookie } = await signedIn();
    const id = uuidv7();
    expect((await call('post', `/api/recurring/${id}/pause`, cookie)).status).toBe(404);
    expect((await call('get', `/api/recurring/${id}/skipped`, cookie)).status).toBe(404);
    expect(
      (await call('post', `/api/recurring/${id}/resume`, cookie, { registerDates: [] })).status,
    ).toBe(404);
  });
});

describe('DELETE /api/recurring/:id', () => {
  it('TASK-233 elimina la regla y sus pendientes', async () => {
    const { cookie, userId } = await signedIn();
    const rule = await createRule(userId);
    await createOccurrence(userId, rule.id);
    expectSuccess(await call('delete', `/api/recurring/${rule.id}`, cookie));
    expect(await ruleRow(rule.id)).toBeUndefined();
    expect(await occurrencesOf(rule.id)).toEqual([]);
  });

  it('TASK-233 una regla inexistente responde 404', async () => {
    const { cookie } = await signedIn();
    expect((await call('delete', `/api/recurring/${uuidv7()}`, cookie)).status).toBe(404);
  });
});

describe('POST /api/recurring/occurrences/:id/confirm', () => {
  it('TASK-233 confirma el pendiente: crea el movimiento de origen recurring y queda registrado', async () => {
    const { cookie, userId } = await signedIn();
    const { occurrence } = await confirmableOccurrence(userId);
    const transactionId = uuidv7();
    const res = await call('post', `/api/recurring/occurrences/${occurrence.id}/confirm`, cookie, {
      transactionId,
      rateUsdBob: '6.96',
    });
    expectSuccess(res);
    expect(await occurrenceStatus(occurrence.id)).toBe('registered');
    const rows = await db.$queryRaw<{ origin: string }[]>`
      SELECT origin::text AS origin FROM ledger_transaction
       WHERE id = ${transactionId}::uuid AND user_id = ${userId}::uuid`;
    expect(rows[0]?.origin).toBe('recurring');
  });

  it('TASK-233 confirmar un pendiente ya decidido responde 409 ALREADY_DECIDED', async () => {
    const { cookie, userId } = await signedIn();
    const rule = await createRule(userId);
    const occurrence = await createOccurrence(userId, rule.id, { status: 'skipped' });
    const res = await call('post', `/api/recurring/occurrences/${occurrence.id}/confirm`, cookie, {
      transactionId: uuidv7(),
      rateUsdBob: '6.96',
    });
    expect(res.status).toBe(409);
    expect(problem(res).code).toBe('ALREADY_DECIDED');
  });

  it('TASK-233 con la cuenta archivada responde 409 ACCOUNT_ARCHIVED', async () => {
    const { cookie, userId } = await signedIn();
    const account = await createAccount(userId, {
      status: 'archived',
      initialBalance: '500.00',
      initialBalanceDate: addDays(localToday(), -30),
    });
    const rule = await createRule(userId, { accountId: account.id, status: 'paused' });
    const occurrence = await createOccurrence(userId, rule.id, {
      scheduledDate: addDays(localToday(), -2),
    });
    const res = await call('post', `/api/recurring/occurrences/${occurrence.id}/confirm`, cookie, {
      transactionId: uuidv7(),
      rateUsdBob: '6.96',
    });
    expect(res.status).toBe(409);
    expect(problem(res).code).toBe('ACCOUNT_ARCHIVED');
    expect(await occurrenceStatus(occurrence.id)).toBe('pending');
  });

  it('TASK-233 con la categoría archivada responde 409 CATEGORY_ARCHIVED', async () => {
    const { cookie, userId } = await signedIn();
    const account = await createAccount(userId, {
      initialBalance: '500.00',
      initialBalanceDate: addDays(localToday(), -30),
    });
    const category = await createCategory(userId, { status: 'archived' });
    const rule = await createRule(userId, {
      accountId: account.id,
      categoryId: category.id,
      status: 'paused',
    });
    const occurrence = await createOccurrence(userId, rule.id, {
      scheduledDate: addDays(localToday(), -2),
    });
    const res = await call('post', `/api/recurring/occurrences/${occurrence.id}/confirm`, cookie, {
      transactionId: uuidv7(),
      rateUsdBob: '6.96',
    });
    expect(res.status).toBe(409);
    expect(problem(res).code).toBe('CATEGORY_ARCHIVED');
    expect(await occurrenceStatus(occurrence.id)).toBe('pending');
  });

  it('TASK-233 un gasto que deja la cuenta en negativo responde 422 NEGATIVE_BALANCE', async () => {
    const { cookie, userId } = await signedIn();
    const { occurrence } = await confirmableOccurrence(userId, '0.00', 'cash');
    const res = await call('post', `/api/recurring/occurrences/${occurrence.id}/confirm`, cookie, {
      transactionId: uuidv7(),
      rateUsdBob: '6.96',
    });
    expect(res.status).toBe(422);
    expect(problem(res).code).toBe('NEGATIVE_BALANCE');
    expect(await occurrenceStatus(occurrence.id)).toBe('pending');
  });

  it('TASK-233 un gasto que toca lo apartado responde 409 EARMARK_CONFIRMATION_REQUIRED', async () => {
    const { cookie, userId } = await signedIn();
    const { account, occurrence } = await confirmableOccurrence(userId, '200.00');
    const goal = await createGoal(userId);
    await createAllocationEvent(userId, goal.id, account.id, { amount: '100.00' });
    const res = await call('post', `/api/recurring/occurrences/${occurrence.id}/confirm`, cookie, {
      transactionId: uuidv7(),
      rateUsdBob: '6.96',
    });
    expect(res.status).toBe(409);
    expect(problem(res).code).toBe('EARMARK_CONFIRMATION_REQUIRED');
    expect(await occurrenceStatus(occurrence.id)).toBe('pending');
  });

  it('TASK-233 sin transactionId responde 400 VALIDATION_ERROR', async () => {
    const { cookie, userId } = await signedIn();
    const { occurrence } = await confirmableOccurrence(userId);
    const res = await call('post', `/api/recurring/occurrences/${occurrence.id}/confirm`, cookie, {
      rateUsdBob: '6.96',
    });
    expect(res.status).toBe(400);
    expect(problem(res).code).toBe('VALIDATION_ERROR');
    expect(await occurrenceStatus(occurrence.id)).toBe('pending');
  });
});

describe('POST /api/recurring/occurrences/:id/skip', () => {
  it('TASK-233 omite el pendiente sin crear movimiento', async () => {
    const { cookie, userId } = await signedIn();
    const rule = await createRule(userId);
    const occurrence = await createOccurrence(userId, rule.id);
    expectSuccess(await call('post', `/api/recurring/occurrences/${occurrence.id}/skip`, cookie));
    expect(await occurrenceStatus(occurrence.id)).toBe('skipped');
  });

  it('TASK-233 omitir un pendiente ya decidido responde 409 ALREADY_DECIDED', async () => {
    const { cookie, userId } = await signedIn();
    const rule = await createRule(userId);
    const occurrence = await createOccurrence(userId, rule.id, { status: 'registered' });
    const res = await call('post', `/api/recurring/occurrences/${occurrence.id}/skip`, cookie);
    expect(res.status).toBe(409);
    expect(problem(res).code).toBe('ALREADY_DECIDED');
  });
});
