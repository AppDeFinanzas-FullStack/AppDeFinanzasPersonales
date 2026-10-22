import type { Express } from 'express';
import request from 'supertest';
import { uuidv7 } from 'uuidv7';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { buildContainer, createApp, type Container } from '../../src/composition/container.js';
import { parseEnv } from '../../src/infrastructure/config/env.js';
import { createAccount } from '../factories/account.factory.js';
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

const newGoalBody = (over: Record<string, unknown> = {}) => ({
  id: uuidv7(),
  name: `Meta ${uuidv7().slice(-8)}`,
  target: '1000.00',
  currencyCode: 'BOB',
  icon: 'piggy-bank',
  color: 'blue',
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
  await deleteGoalsOf(usedUsers);
  await db.$executeRaw`DELETE FROM auth_user WHERE email = ANY(${usedEmails}::text[])`;
  await db.$executeRaw`DELETE FROM email_outbox WHERE to_address = ANY(${usedEmails}::text[])`;
  await disconnectTestPrisma();
  await container.prisma.$disconnect();
}, 30_000);

describe('aislamiento de metas entre usuarios', () => {
  it('RNF-14 GET /api/goals no lista las metas de otro usuario', async () => {
    const a = await signedIn();
    const b = await signedIn();
    const goal = await createGoal(a.userId);
    const res = await call('get', '/api/goals', b.cookie);
    expect(res.status).toBe(200);
    expect(JSON.stringify(res.body)).not.toContain(goal.id);
  });

  it('RNF-14 el usuario B recibe 404 en cada endpoint con una meta de A', async () => {
    const a = await signedIn();
    const b = await signedIn();
    const goal = await createGoal(a.userId);
    const accB = await createAccount(b.userId, { initialBalance: '500.00' });
    const id = goal.id;
    const attempts: [string, Method, string, object | undefined][] = [
      ['GET :id', 'get', `/api/goals/${id}`, undefined],
      ['PATCH', 'patch', `/api/goals/${id}`, { name: 'Robada' }],
      [
        'earmarks',
        'post',
        `/api/goals/${id}/earmarks`,
        { id: uuidv7(), accountId: accB.id, amount: '10.00' },
      ],
      [
        'release',
        'post',
        `/api/goals/${id}/earmarks/release`,
        { accountId: accB.id, amount: '10.00' },
      ],
      ['dedicate', 'post', `/api/goals/${id}/dedicate`, { accountId: accB.id }],
      ['use-and-close', 'post', `/api/goals/${id}/use-and-close`, undefined],
      ['archive', 'post', `/api/goals/${id}/archive`, undefined],
      ['restore', 'post', `/api/goals/${id}/restore`, undefined],
      ['celebrated', 'post', `/api/goals/${id}/celebrated`, undefined],
      ['DELETE', 'delete', `/api/goals/${id}`, undefined],
    ];
    for (const [label, method, path, body] of attempts) {
      const res = await call(method, path, b.cookie, body);
      expect(res.status, label).toBe(404);
    }
    const rows = await db.$queryRaw<{ name: string; archived: boolean }[]>`
      SELECT name, (archived_at IS NOT NULL) AS archived FROM goal WHERE id = ${id}::uuid`;
    expect(rows).toHaveLength(1);
    expect(rows[0]?.name).toBe(goal.name);
    expect(rows[0]?.archived).toBe(false);
  });

  it('RNF-14 B no aparta en una cuenta de A con una meta propia: 404', async () => {
    const a = await signedIn();
    const b = await signedIn();
    const accA = await createAccount(a.userId, { initialBalance: '500.00' });
    const goalB = await createGoal(b.userId);
    const res = await call('post', `/api/goals/${goalB.id}/earmarks`, b.cookie, {
      id: uuidv7(),
      accountId: accA.id,
      amount: '10.00',
    });
    expect(res.status).toBe(404);
    const rows = await db.$queryRaw<{ n: bigint }[]>`
      SELECT count(*) AS n FROM goal_allocation_event WHERE account_id = ${accA.id}::uuid`;
    expect(Number(rows[0]?.n)).toBe(0);
  });

  it('RNF-14 B no dedica ni libera una cuenta de A con una meta propia: 404', async () => {
    const a = await signedIn();
    const b = await signedIn();
    const accA = await createAccount(a.userId, { initialBalance: '500.00' });
    const goalB = await createGoal(b.userId);
    const ded = await call('post', `/api/goals/${goalB.id}/dedicate`, b.cookie, {
      accountId: accA.id,
    });
    expect(ded.status).toBe(404);
    const rel = await call('post', `/api/goals/${goalB.id}/earmarks/release`, b.cookie, {
      accountId: accA.id,
      amount: '10.00',
    });
    expect(rel.status).toBe(404);
  });

  it('RNF-14 B no crea una meta dedicada a una cuenta de A: 404', async () => {
    const a = await signedIn();
    const b = await signedIn();
    const accA = await createAccount(a.userId, { initialBalance: '500.00' });
    const res = await call(
      'post',
      '/api/goals',
      b.cookie,
      newGoalBody({ dedicatedAccountId: accA.id }),
    );
    expect(res.status).toBe(404);
  });
});
