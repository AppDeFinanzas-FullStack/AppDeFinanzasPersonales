import type { DebtDto } from '@finanzas/contracts';
import type { Express } from 'express';
import request from 'supertest';
import { uuidv7 } from 'uuidv7';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { buildContainer, createApp, type Container } from '../../src/composition/container.js';
import { parseEnv } from '../../src/infrastructure/config/env.js';
import { createAccount } from '../factories/account.factory.js';
import {
  createDebt,
  createDebtPayment,
  findStoredDebt,
  storedPaymentIdsOf,
} from '../factories/debt.factory.js';
import { deleteGoalsOf } from '../factories/goal.factory.js';
import { deleteLedgerOf } from '../factories/ledger.factory.js';
import { countTransactionsOf } from '../factories/transaction.factory.js';
import { disconnectTestPrisma, testPrisma } from '../integration/setup/db.js';

/** RNF-14 on the routes of plan §4.13.2: another user's debt or account behaves as nonexistent. */

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

interface DebtsList {
  debts: DebtDto[];
}
const listOf = (res: { body: unknown }) => res.body as DebtsList;

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

const START = '2025-01-01';
const PAY_DATE = '2025-06-01';
const ACCOUNT_SINCE = '2024-01-01';

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
  if (method === 'get') return req;
  if (method === 'delete') return body === undefined ? req : req.send(body);
  return req.send(body ?? {});
};

const paymentBody = (over: Record<string, unknown> = {}) => ({
  id: uuidv7(),
  amount: '100.00',
  interestPart: '0.00',
  capitalPart: '100.00',
  date: PAY_DATE,
  ...over,
});

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
  if (usedUsers.length > 0) {
    await db.$executeRaw`DELETE FROM debt WHERE user_id = ANY(${usedUsers}::uuid[])`;
  }
  await deleteGoalsOf(usedUsers);
  await deleteLedgerOf(usedUsers);
  await db.$executeRaw`DELETE FROM auth_user WHERE email = ANY(${usedEmails}::text[])`;
  await db.$executeRaw`DELETE FROM email_outbox WHERE to_address = ANY(${usedEmails}::text[])`;
  await disconnectTestPrisma();
  await container.prisma.$disconnect();
}, 30_000);

describe('aislamiento de deudas entre usuarios', () => {
  it('RNF-14 GET /api/debts no lista las deudas de otro usuario en ninguna vista', async () => {
    const a = await signedIn();
    const b = await signedIn();
    const debt = await createDebt(a.userId, { startDate: START, person: 'Persona de A' });
    for (const view of ['debt', 'person']) {
      const res = await call('get', `/api/debts?view=${view}`, b.cookie);
      expect(res.status, view).toBe(200);
      expect(listOf(res).debts.map((d) => d.id)).not.toContain(debt.id);
      expect(JSON.stringify(res.body)).not.toContain('Persona de A');
    }
  });

  it('RNF-14 el usuario B recibe 404 en cada endpoint con una deuda de A', async () => {
    const a = await signedIn();
    const b = await signedIn();
    const debt = await createDebt(a.userId, { startDate: START, capitalOutstanding: '900.00' });
    const payment = await createDebtPayment(a.userId, debt.id, { date: PAY_DATE });
    const id = debt.id;
    const attempts: [string, Method, string, object | undefined][] = [
      ['PATCH', 'patch', `/api/debts/${id}`, { person: 'Robada' }],
      ['payments', 'post', `/api/debts/${id}/payments`, paymentBody()],
      ['payments/last', 'delete', `/api/debts/${id}/payments/last`, undefined],
      ['forgive', 'post', `/api/debts/${id}/forgive`, undefined],
      ['DELETE', 'delete', `/api/debts/${id}`, undefined],
      ['DELETE keep', 'delete', `/api/debts/${id}?movements=keep`, { movements: 'keep' }],
    ];
    for (const [label, method, path, body] of attempts) {
      const res = await call(method, path, b.cookie, body);
      expect(res.status, label).toBe(404);
    }
    const stored = await findStoredDebt(id);
    expect(stored).not.toBeNull();
    expect(stored?.person).toBe(debt.person);
    expect(stored?.status).toBe('active');
    expect(stored?.capitalOutstanding).toBe('900.00');
    expect(await storedPaymentIdsOf(id)).toEqual([payment.id]);
  });

  it('RNF-14 B no paga su deuda desde una cuenta de A: 404', async () => {
    const a = await signedIn();
    const b = await signedIn();
    const accA = await createAccount(a.userId, {
      initialBalance: '500.00',
      initialBalanceDate: ACCOUNT_SINCE,
    });
    const debtB = await createDebt(b.userId, { startDate: START });
    const res = await call(
      'post',
      `/api/debts/${debtB.id}/payments`,
      b.cookie,
      paymentBody({
        account: {
          accountId: accA.id,
          capitalTransactionId: uuidv7(),
          interestTransactionId: uuidv7(),
        },
      }),
    );
    expect(res.status).toBe(404);
    expect(await storedPaymentIdsOf(debtB.id)).toEqual([]);
    expect(await countTransactionsOf(a.userId)).toBe(0);
  });

  it('RNF-14 B no crea una deuda con movimiento inicial en una cuenta de A: 404', async () => {
    const a = await signedIn();
    const b = await signedIn();
    const accA = await createAccount(a.userId, { initialBalanceDate: ACCOUNT_SINCE });
    const id = uuidv7();
    const res = await call('post', '/api/debts', b.cookie, {
      id,
      direction: 'i_owe',
      person: 'Juan',
      principal: '100.00',
      currencyCode: 'BOB',
      startDate: START,
      initialMovement: { transactionId: uuidv7(), accountId: accA.id },
    });
    expect(res.status).toBe(404);
    expect(await findStoredDebt(id)).toBeNull();
    expect(await countTransactionsOf(a.userId)).toBe(0);
  });
});
