import { createHmac, randomUUID } from 'node:crypto';

import { DEFAULT_DASHBOARD_BLOCKS, type DashboardDto } from '@finanzas/contracts';
import type { Express } from 'express';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { buildContainer, createApp, type Container } from '../../src/composition/container.js';
import { parseEnv } from '../../src/infrastructure/config/env.js';
import { createAccount } from '../factories/account.factory.js';
import { createCategory } from '../factories/category.factory.js';
import { createLedgerTransaction, deleteLedgerOf } from '../factories/ledger.factory.js';
import { disconnectTestPrisma, testPrisma } from '../integration/setup/db.js';

/**
 * `GET /api/dashboard?month` (plan §4.8.2). Accounts are made through `sign-up` and `confirm`
 * over the test database with fake integrations, as in `settings.test.ts`; the ledger is written
 * by SQL with the factories. The months used are in the past so "today" never falls inside them.
 */
const WEB_ORIGIN = 'http://localhost:5173';
const COOKIE_NAME = '__Secure-better-auth.session_token';
const HMAC_SECRET = 'hmac-secret-value-0123456789abcdef0123456789';
const PASSWORD = 'Clave-segura-123';

const envSource = (): Record<string, string> => ({
  NODE_ENV: 'test',
  PORT: '3000',
  DATABASE_URL: process.env['TEST_DATABASE_URL'] ?? '',
  AUTH_SECRET: 'auth-secret-value-0123456789abcdef0123456789',
  HMAC_SECRET,
  JOBS_SECRET: 'jobs-secret-value-0123456789abcdef0123456789',
  RESEND_API_KEY: 're_resend-key-value-0123456789',
  RELEASE: '1.0',
  WEB_ORIGIN,
  INTEGRATIONS: 'fake',
});

interface Problem {
  code?: string;
  status?: number;
}
const problem = (res: { body: unknown }) => res.body as Problem;

let container: Container;
let app: Express;
const usedEmails = new Set<string>();
const usedUserIds: string[] = [];

beforeAll(async () => {
  container = await Promise.resolve(buildContainer(parseEnv(envSource())));
  app = await Promise.resolve(createApp(container));
});

const hmacOf = (email: string) =>
  createHmac('sha256', HMAC_SECRET).update(email.trim().toLowerCase()).digest('hex');

afterAll(async () => {
  const emails = [...usedEmails];
  const db = testPrisma();
  await deleteLedgerOf(usedUserIds);
  await db.$executeRaw`DELETE FROM auth_user WHERE email = ANY(${emails}::text[])`;
  await db.$executeRaw`DELETE FROM email_outbox WHERE to_address = ANY(${emails}::text[])`;
  await db.$executeRaw`
    DELETE FROM email_send_log WHERE email_hmac = ANY(${emails.map(hmacOf)}::text[])`;
  await disconnectTestPrisma();
  await container.prisma.$disconnect();
});

const post = (path: string, body: object, cookie?: string) => {
  const req = request(app).post(path).set('Origin', WEB_ORIGIN);
  if (cookie !== undefined) req.set('Cookie', cookie);
  return req.send(body);
};

const get = (path: string, cookie?: string) => {
  const req = request(app).get(path);
  if (cookie !== undefined) req.set('Cookie', cookie);
  return req;
};

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
  email: string;
  cookie: string;
  userId: string;
}

async function activeAccount(): Promise<Account> {
  const email = `${randomUUID()}@http-dashboard.test`;
  usedEmails.add(email);
  const up = await post('/api/auth/sign-up', {
    name: 'Ana Pérez',
    email,
    password: PASSWORD,
    acceptTerms: true,
  });
  expect(up.status).toBe(202);
  const links = await testPrisma().$queryRaw<{ link: string | null }[]>`
    SELECT payload->>'link' AS link FROM email_outbox
    WHERE to_address = ${email} AND kind = 'confirm'::email_kind
    ORDER BY created_at DESC, id DESC LIMIT 1`;
  const token = /[A-Za-z0-9_-]{43}/.exec(links[0]?.link ?? '')?.[0];
  if (token === undefined) throw new Error('no confirmation token');
  const res = await post('/api/auth/confirm', { token });
  expect(res.status).toBe(200);
  const users = await testPrisma().$queryRaw<{ id: string }[]>`
    SELECT id::text AS id FROM auth_user WHERE email = ${email}`;
  const userId = users[0]?.id;
  if (userId === undefined) throw new Error('no user');
  usedUserIds.push(userId);
  return { email, cookie: sessionCookieOf(res), userId };
}

const dashboard = (month: string, cookie?: string) => get(`/api/dashboard?month=${month}`, cookie);

const bodyOf = (res: { body: unknown }) => res.body as DashboardDto;

const MONTH = '2025-03';

async function spend(
  userId: string,
  accountId: string,
  date: string,
  amount: string,
  categoryId?: string,
): Promise<void> {
  await createLedgerTransaction(userId, {
    kind: 'expense',
    date,
    entries: [{ accountId, amount: `-${amount}` }],
    ...(categoryId === undefined ? {} : { categoryId }),
  });
}

describe('GET /api/dashboard', () => {
  it('TASK-146 sin sesión responde 401', async () => {
    expect((await dashboard(MONTH)).status).toBe(401);
  });

  it('TASK-146 un mes inválido responde 400 VALIDATION_ERROR', async () => {
    const { cookie } = await activeAccount();
    const res = await dashboard('marzo', cookie);
    expect(res.status).toBe(400);
    expect(problem(res).code).toBe('VALIDATION_ERROR');
  });

  it('RF-M8-05 una subcategoría suma a su padre y la sexta categoría va a Otras', async () => {
    const { cookie, userId } = await activeAccount();
    const account = await createAccount(userId, { initialBalanceDate: '2020-01-01' });
    const parents = [];
    for (const amount of ['60.00', '50.00', '40.00', '30.00', '20.00', '10.00']) {
      const category = await createCategory(userId, { kind: 'expense' });
      parents.push(category);
      await spend(userId, account.id, '2025-03-10', amount, category.id);
    }
    const child = await createCategory(userId, { parentId: parents[0]?.id ?? null });
    await spend(userId, account.id, '2025-03-11', '5.00', child.id);

    const res = await dashboard(MONTH, cookie);

    expect(res.status).toBe(200);
    const { byCategory } = bodyOf(res);
    expect(byCategory.top.map((t) => t.amount)).toEqual([
      '65.00',
      '50.00',
      '40.00',
      '30.00',
      '20.00',
    ]);
    expect(byCategory.top[0]?.categoryId).toBe(parents[0]?.id);
    expect(byCategory.others?.amount).toBe('10.00');
  });

  it('RF-M5-03 el total de un padre incluye el de sus subcategorías', async () => {
    const { cookie, userId } = await activeAccount();
    const account = await createAccount(userId, { initialBalanceDate: '2020-01-01' });
    const parent = await createCategory(userId, { kind: 'expense' });
    const child = await createCategory(userId, { parentId: parent.id });
    await spend(userId, account.id, '2025-03-10', '10.00', parent.id);
    await spend(userId, account.id, '2025-03-11', '25.00', child.id);

    const { byCategory } = bodyOf(await dashboard(MONTH, cookie));

    expect(byCategory.top).toHaveLength(1);
    expect(byCategory.top[0]?.categoryId).toBe(parent.id);
    expect(byCategory.top[0]?.amount).toBe('35.00');
    expect(byCategory.others).toBeNull();
  });

  it('RF-M5-09 después de mover una subcategoría, los totales del mes pasado cambian', async () => {
    const { cookie, userId } = await activeAccount();
    const account = await createAccount(userId, { initialBalanceDate: '2020-01-01' });
    const p1 = await createCategory(userId, { kind: 'expense' });
    const p2 = await createCategory(userId, { kind: 'expense' });
    const child = await createCategory(userId, { parentId: p1.id });
    await spend(userId, account.id, '2025-03-10', '10.00', p1.id);
    await spend(userId, account.id, '2025-03-10', '20.00', p2.id);
    await spend(userId, account.id, '2025-03-11', '100.00', child.id);

    const amountOf = (dto: DashboardDto, id: string) =>
      dto.byCategory.top.find((t) => t.categoryId === id)?.amount;
    const before = bodyOf(await dashboard(MONTH, cookie));
    expect(amountOf(before, p1.id)).toBe('110.00');
    expect(amountOf(before, p2.id)).toBe('20.00');

    await testPrisma().$executeRaw`
      UPDATE category SET parent_id = ${p2.id}::uuid WHERE id = ${child.id}::uuid`;

    const after = bodyOf(await dashboard(MONTH, cookie));
    expect(amountOf(after, p1.id)).toBe('10.00');
    expect(amountOf(after, p2.id)).toBe('120.00');
  });

  it('RF-M8-06 el ritmo acumula día a día contra el mes anterior completo', async () => {
    const { cookie, userId } = await activeAccount();
    const account = await createAccount(userId, { initialBalanceDate: '2020-01-01' });
    await spend(userId, account.id, '2025-03-02', '10.00');
    await spend(userId, account.id, '2025-03-05', '20.00');
    await spend(userId, account.id, '2025-02-03', '7.00');
    await spend(userId, account.id, '2025-02-27', '3.00');

    const { pace } = bodyOf(await dashboard(MONTH, cookie));

    const cumulativeOn = (list: { day: number; cumulative: string }[], day: number) =>
      list.filter((p) => p.day <= day).at(-1)?.cumulative;
    expect(cumulativeOn(pace.current, 2)).toBe('10.00');
    expect(cumulativeOn(pace.current, 31)).toBe('30.00');
    expect(cumulativeOn(pace.previous, 3)).toBe('7.00');
    expect(cumulativeOn(pace.previous, 28)).toBe('10.00');
  });

  it('RF-M8-07 los saldos son los de hoy aunque se pida un mes pasado', async () => {
    const { cookie, userId } = await activeAccount();
    const account = await createAccount(userId, {
      initialBalance: '100.00',
      initialBalanceDate: '2020-01-01',
    });
    await createLedgerTransaction(userId, {
      kind: 'income',
      date: '2025-03-10',
      entries: [{ accountId: account.id, amount: '500.00' }],
    });
    await spend(userId, account.id, '2025-06-10', '50.00');

    const { balances } = bodyOf(await dashboard(MONTH, cookie));

    expect(balances.asOfToday).toBe(true);
    expect(balances.netWorth.base).toBe('550.00');
    expect(balances.top.map((a) => a.id)).toEqual([account.id]);
  });

  it('RF-M8-07 las cuentas son las 5 primeras y los últimos movimientos son 5', async () => {
    const { cookie, userId } = await activeAccount();
    const accounts = [];
    for (let i = 0; i < 7; i += 1) {
      accounts.push(await createAccount(userId, { initialBalanceDate: '2020-01-01' }));
    }
    for (let i = 1; i <= 7; i += 1) {
      await spend(userId, accounts[0]?.id ?? '', `2025-03-0${i}`, '1.00');
    }

    const { balances, recent } = bodyOf(await dashboard(MONTH, cookie));

    expect(balances.top.map((a) => a.id)).toEqual(accounts.slice(0, 5).map((a) => a.id));
    expect(recent).toHaveLength(5);
  });

  it('EC-M8-04 sin tasa, netWorth.other es null', async () => {
    const { cookie, userId } = await activeAccount();
    await createAccount(userId, { initialBalance: '100.00', initialBalanceDate: '2020-01-01' });

    const { balances } = bodyOf(await dashboard(MONTH, cookie));

    expect(balances.netWorth.base).toBe('100.00');
    expect(balances.netWorth.other).toBeNull();
  });

  it('RF-M8-10 un bloque oculto no viene en la respuesta', async () => {
    const { cookie } = await activeAccount();
    const visible = bodyOf(await dashboard(MONTH, cookie));
    expect(visible).toHaveProperty('byCategory');
    expect(visible).toHaveProperty('pace');

    const blocks = DEFAULT_DASHBOARD_BLOCKS.map((b) =>
      b.key === 'byCategory' ? { ...b, visible: false } : b,
    );
    const patch = await request(app)
      .patch('/api/settings')
      .set('Origin', WEB_ORIGIN)
      .set('Cookie', cookie)
      .send({ dashboardBlocks: blocks });
    expect(patch.status).toBe(200);

    const hidden = await dashboard(MONTH, cookie);
    expect(hidden.status).toBe(200);
    expect(hidden.body).not.toHaveProperty('byCategory');
    expect(hidden.body).toHaveProperty('pace');
  });

  it('RF-M8-10 los bloques no liberados (presupuestos, próximos) se omiten con RELEASE=1.0', async () => {
    const { cookie } = await activeAccount();
    const res = await dashboard(MONTH, cookie);
    expect(res.status).toBe(200);
    expect(res.body).not.toHaveProperty('budgets');
    expect(res.body).not.toHaveProperty('upcoming');
  });

  it('RNF-14 el usuario B nunca ve datos de A', async () => {
    const a = await activeAccount();
    const b = await activeAccount();
    const account = await createAccount(a.userId, {
      initialBalance: '900.00',
      initialBalanceDate: '2020-01-01',
    });
    const category = await createCategory(a.userId, { kind: 'expense' });
    await spend(a.userId, account.id, '2025-03-10', '77.00', category.id);

    const seenByA = bodyOf(await dashboard(MONTH, a.cookie));
    expect(seenByA.cards.expense).toBe('77.00');

    const seenByB = bodyOf(await dashboard(MONTH, b.cookie));
    expect(seenByB.cards.expense).toBe('0.00');
    expect(seenByB.byCategory.top).toEqual([]);
    expect(seenByB.balances.netWorth.base).toBe('0.00');
    expect(seenByB.balances.top).toEqual([]);
    expect(seenByB.recent).toEqual([]);
  });
});
