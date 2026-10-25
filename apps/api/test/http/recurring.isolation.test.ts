import type { Express } from 'express';
import request from 'supertest';
import { uuidv7 } from 'uuidv7';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { buildContainer, createApp, type Container } from '../../src/composition/container.js';
import { parseEnv } from '../../src/infrastructure/config/env.js';
import { createAccount } from '../factories/account.factory.js';
import { createCategory } from '../factories/category.factory.js';
import { deleteLedgerOf } from '../factories/ledger.factory.js';
import {
  createOccurrence,
  createRule,
  deleteRecurringOf,
  occurrenceStatus,
} from '../factories/recurring.factory.js';
import { disconnectTestPrisma, testPrisma } from '../integration/setup/db.js';

/** Isolation of `/api/recurring` between users (RNF-14, plan §4.14.2). */
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

/** The answer without what changes on every request. */
const shape = (res: { status: number; body: unknown }) => {
  const body = res.body;
  if (typeof body !== 'object' || body === null) return { status: res.status, body };
  const copy = { ...(body as Record<string, unknown>) };
  delete copy['traceId'];
  return { status: res.status, body: copy };
};

const ruleRow = async (id: string) =>
  (
    await db.$queryRaw<{ name: string; status: string; userId: string }[]>`
      SELECT name, status::text AS status, user_id::text AS "userId"
        FROM recurring_rule WHERE id = ${id}::uuid`
  )[0];

const countTransactions = async (userId: string) =>
  Number(
    (
      await db.$queryRaw<{ n: bigint }[]>`
        SELECT count(*) AS n FROM ledger_transaction WHERE user_id = ${userId}::uuid`
    )[0]?.n ?? 0,
  );

beforeAll(async () => {
  process.env['RELEASE'] = '1.2';
  container = await Promise.resolve(buildContainer(parseEnv(envSource())));
  app = await Promise.resolve(createApp(container));
}, 30_000);

afterAll(async () => {
  if (originalRelease === undefined) delete process.env['RELEASE'];
  else process.env['RELEASE'] = originalRelease;
  await sleep(300);
  await deleteRecurringOf(usedUsers);
  await deleteLedgerOf(usedUsers);
  await db.$executeRaw`DELETE FROM auth_user WHERE email = ANY(${usedEmails}::text[])`;
  await db.$executeRaw`DELETE FROM email_outbox WHERE to_address = ANY(${usedEmails}::text[])`;
  await disconnectTestPrisma();
  await container.prisma.$disconnect();
}, 30_000);

describe('aislamiento de recurrentes entre usuarios', () => {
  it('RNF-14 GET /api/recurring no lista las reglas ni los pendientes de otro usuario', async () => {
    const a = await signedIn();
    const b = await signedIn();
    const rule = await createRule(a.userId);
    const occurrence = await createOccurrence(a.userId, rule.id);
    const res = await call('get', '/api/recurring', b.cookie);
    expect(res.status).toBe(200);
    expect(res.text).not.toContain(rule.id);
    expect(res.text).not.toContain(rule.name);
    expect(res.text).not.toContain(occurrence.id);
  });

  it('RNF-14 el usuario B recibe 404 en cada endpoint con una regla de A', async () => {
    const a = await signedIn();
    const b = await signedIn();
    const rule = await createRule(a.userId);
    const occurrence = await createOccurrence(a.userId, rule.id);
    const id = rule.id;
    const attempts: [string, Method, string, object | undefined][] = [
      ['PATCH', 'patch', `/api/recurring/${id}`, { name: 'Robada' }],
      ['pause', 'post', `/api/recurring/${id}/pause`, undefined],
      ['skipped', 'get', `/api/recurring/${id}/skipped`, undefined],
      ['resume', 'post', `/api/recurring/${id}/resume`, { registerDates: [] }],
      ['DELETE', 'delete', `/api/recurring/${id}`, undefined],
    ];
    for (const [label, method, path, body] of attempts) {
      const res = await call(method, path, b.cookie, body);
      expect(res.status, label).toBe(404);
    }
    const row = await ruleRow(id);
    expect(row?.name).toBe(rule.name);
    expect(row?.status).toBe('active');
    expect(row?.userId).toBe(a.userId);
    expect(await occurrenceStatus(occurrence.id)).toBe('pending');
  });

  it('RNF-14 el usuario B recibe 404 al confirmar u omitir una ocurrencia de A', async () => {
    const a = await signedIn();
    const b = await signedIn();
    const account = await createAccount(a.userId, {
      initialBalance: '500.00',
      initialBalanceDate: addDays(localToday(), -30),
    });
    const rule = await createRule(a.userId, { accountId: account.id });
    const occurrence = await createOccurrence(a.userId, rule.id, {
      scheduledDate: addDays(localToday(), -2),
    });
    const confirm = await call(
      'post',
      `/api/recurring/occurrences/${occurrence.id}/confirm`,
      b.cookie,
      { transactionId: uuidv7(), rateUsdBob: '6.96' },
    );
    expect(confirm.status).toBe(404);
    const skip = await call('post', `/api/recurring/occurrences/${occurrence.id}/skip`, b.cookie);
    expect(skip.status).toBe(404);
    expect(await occurrenceStatus(occurrence.id)).toBe('pending');
    expect(await countTransactions(a.userId)).toBe(0);
    expect(await countTransactions(b.userId)).toBe(0);
  });

  it('RNF-14 una regla o una ocurrencia de A responde igual que una inexistente', async () => {
    const a = await signedIn();
    const b = await signedIn();
    const rule = await createRule(a.userId);
    const occurrence = await createOccurrence(a.userId, rule.id);
    const pairs: [string, Method, (id: string) => string, object | undefined][] = [
      ['PATCH', 'patch', (id) => `/api/recurring/${id}`, { name: 'Robada' }],
      ['pause', 'post', (id) => `/api/recurring/${id}/pause`, undefined],
      ['skipped', 'get', (id) => `/api/recurring/${id}/skipped`, undefined],
      ['DELETE', 'delete', (id) => `/api/recurring/${id}`, undefined],
    ];
    for (const [label, method, path, body] of pairs) {
      const theirs = await call(method, path(rule.id), b.cookie, body);
      const missing = await call(method, path(uuidv7()), b.cookie, body);
      expect(shape(theirs), label).toEqual(shape(missing));
    }
    const skipTheirs = await call('post', `/api/recurring/occurrences/${occurrence.id}/skip`, b.cookie);
    const skipMissing = await call('post', `/api/recurring/occurrences/${uuidv7()}/skip`, b.cookie);
    expect(skipTheirs.status).toBe(404);
    expect(shape(skipTheirs)).toEqual(shape(skipMissing));
  });

  it('RNF-14 B no crea una regla sobre una cuenta o una categoría de A: responde como con una inexistente', async () => {
    const a = await signedIn();
    const b = await signedIn();
    const accA = await createAccount(a.userId);
    const catA = await createCategory(a.userId);
    const accB = await createAccount(b.userId);
    const catB = await createCategory(b.userId);
    const body = (accountId: string, categoryId: string) => ({
      id: uuidv7(),
      name: `Regla ${uuidv7().slice(-8)}`,
      kind: 'expense',
      amount: '10.00',
      accountId,
      categoryId,
      frequency: { type: 'monthly', day: 5 },
      startDate: addDays(localToday(), 30),
      end: { type: 'none' },
      mode: 'auto',
    });
    const onAccount = await call('post', '/api/recurring', b.cookie, body(accA.id, catB.id));
    const onMissingAccount = await call('post', '/api/recurring', b.cookie, body(uuidv7(), catB.id));
    expect(onAccount.status).toBeGreaterThanOrEqual(400);
    expect(shape(onAccount)).toEqual(shape(onMissingAccount));
    const onCategory = await call('post', '/api/recurring', b.cookie, body(accB.id, catA.id));
    const onMissingCategory = await call('post', '/api/recurring', b.cookie, body(accB.id, uuidv7()));
    expect(onCategory.status).toBeGreaterThanOrEqual(400);
    expect(shape(onCategory)).toEqual(shape(onMissingCategory));
    const rows = await db.$queryRaw<{ n: bigint }[]>`
      SELECT count(*) AS n FROM recurring_rule WHERE user_id = ${b.userId}::uuid`;
    expect(Number(rows[0]?.n)).toBe(0);
  });

  it('RNF-14 B no confirma una ocurrencia propia sobre una cuenta de A: 404', async () => {
    const a = await signedIn();
    const b = await signedIn();
    const accA = await createAccount(a.userId, {
      initialBalance: '500.00',
      initialBalanceDate: addDays(localToday(), -30),
    });
    const rule = await createRule(b.userId);
    const occurrence = await createOccurrence(b.userId, rule.id, {
      scheduledDate: addDays(localToday(), -2),
    });
    const res = await call('post', `/api/recurring/occurrences/${occurrence.id}/confirm`, b.cookie, {
      transactionId: uuidv7(),
      rateUsdBob: '6.96',
      accountId: accA.id,
    });
    expect(res.status).toBe(404);
    expect(problem(res).code).not.toBe('ALREADY_DECIDED');
    expect(await occurrenceStatus(occurrence.id)).toBe('pending');
    expect(await countTransactions(a.userId)).toBe(0);
  });
});
