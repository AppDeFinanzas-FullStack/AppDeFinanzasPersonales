import { createHmac, randomUUID } from 'node:crypto';

import type { RegisterContextDto, SettingsDto } from '@finanzas/contracts';
import type { Express } from 'express';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { buildContainer, createApp, type Container } from '../../src/composition/container.js';
import { parseEnv } from '../../src/infrastructure/config/env.js';
import { createAccount } from '../factories/account.factory.js';
import { createCategory } from '../factories/category.factory.js';
import { disconnectTestPrisma, testPrisma } from '../integration/setup/db.js';

/**
 * `PATCH /api/settings` with `defaultAccountId` and `favoriteCategories` (plan §4.9.2), read back
 * through `GET /api/settings` and `GET /api/register/context` (plan §4.7.2). Accounts are made
 * through `sign-up` and `confirm` over the test database with fake integrations, as in
 * `settings.test.ts`; accounts and categories are written by SQL with the factories.
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

beforeAll(async () => {
  container = await Promise.resolve(buildContainer(parseEnv(envSource())));
  app = await Promise.resolve(createApp(container));
});

const hmacOf = (email: string) =>
  createHmac('sha256', HMAC_SECRET).update(email.trim().toLowerCase()).digest('hex');

afterAll(async () => {
  const emails = [...usedEmails];
  const db = testPrisma();
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
  cookie: string;
  userId: string;
}

async function activeAccount(): Promise<Account> {
  const email = `${randomUUID()}@http-settings-register.test`;
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
  return { cookie: sessionCookieOf(res), userId };
}

const patchSettings = (body: object, cookie?: string) => {
  const req = request(app).patch('/api/settings').set('Origin', WEB_ORIGIN);
  if (cookie !== undefined) req.set('Cookie', cookie);
  return req.send(body);
};

const readSettings = async (cookie: string): Promise<SettingsDto> => {
  const res = await get('/api/settings', cookie);
  expect(res.status).toBe(200);
  return res.body as SettingsDto;
};

const readContext = async (cookie: string): Promise<RegisterContextDto> => {
  const res = await get('/api/register/context', cookie);
  expect(res.status).toBe(200);
  return res.body as RegisterContextDto;
};

describe('PATCH /api/settings: cuenta por defecto', () => {
  it('RF-M7-03 la cuenta por defecto se guarda y register/context la devuelve', async () => {
    const { cookie, userId } = await activeAccount();
    await createAccount(userId);
    const chosen = await createAccount(userId);

    const res = await patchSettings({ defaultAccountId: chosen.id }, cookie);

    expect(res.status).toBe(200);
    expect((res.body as SettingsDto).defaultAccountId).toBe(chosen.id);
    expect((await readSettings(cookie)).defaultAccountId).toBe(chosen.id);
    expect((await readContext(cookie)).defaultAccountId).toBe(chosen.id);
  });

  it('RF-M7-03 defaultAccountId null deja sin cuenta por defecto', async () => {
    const { cookie, userId } = await activeAccount();
    const chosen = await createAccount(userId);
    expect((await patchSettings({ defaultAccountId: chosen.id }, cookie)).status).toBe(200);

    const res = await patchSettings({ defaultAccountId: null }, cookie);

    expect(res.status).toBe(200);
    expect((await readSettings(cookie)).defaultAccountId).toBeNull();
    expect((await readContext(cookie)).defaultAccountId).toBeNull();
  });

  it('EC-M9-02 una cuenta archivada como cuenta por defecto da 409 ACCOUNT_ARCHIVED', async () => {
    const { cookie, userId } = await activeAccount();
    const archived = await createAccount(userId, { status: 'archived' });

    const res = await patchSettings({ defaultAccountId: archived.id }, cookie);

    expect(res.status).toBe(409);
    expect(problem(res).code).toBe('ACCOUNT_ARCHIVED');
    expect((await readSettings(cookie)).defaultAccountId).toBeNull();
  });

  it('EC-M9-02 la cuenta por defecto que luego se archiva deja de devolverse', async () => {
    const { cookie, userId } = await activeAccount();
    const chosen = await createAccount(userId);
    expect((await patchSettings({ defaultAccountId: chosen.id }, cookie)).status).toBe(200);

    const archive = await post(`/api/accounts/${chosen.id}/archive`, {}, cookie);

    expect(archive.status).toBe(200);
    expect((await readSettings(cookie)).defaultAccountId).toBeNull();
    expect((await readContext(cookie)).defaultAccountId).toBeNull();
  });

  it('TASK-149 aislamiento: la cuenta de otro usuario no se guarda como cuenta por defecto', async () => {
    const a = await activeAccount();
    const b = await activeAccount();
    const ofB = await createAccount(b.userId);

    const res = await patchSettings({ defaultAccountId: ofB.id }, a.cookie);

    expect(res.status).toBeGreaterThanOrEqual(400);
    expect((await readSettings(a.cookie)).defaultAccountId).toBeNull();
  });
});

describe('PATCH /api/settings: categorías favoritas', () => {
  it('RF-M7-04 guardar 3 favoritas las pone primeras en la grilla, en su orden', async () => {
    const { cookie, userId } = await activeAccount();
    const c1 = await createCategory(userId, { kind: 'expense' });
    const c2 = await createCategory(userId, { kind: 'expense' });
    const c3 = await createCategory(userId, { kind: 'expense' });
    const ids = [c3.id, c1.id, c2.id];

    const res = await patchSettings({ favoriteCategories: { kind: 'expense', ids } }, cookie);

    expect(res.status).toBe(200);
    expect((await readSettings(cookie)).favorites).toEqual({ expense: ids, income: [] });
    const { grid } = await readContext(cookie);
    expect(grid.expense.slice(0, 3).map((chip) => chip.id)).toEqual(ids);
  });

  it('RF-M7-04 una subcategoría también puede ser favorita', async () => {
    const { cookie, userId } = await activeAccount();
    const parent = await createCategory(userId, { kind: 'income' });
    const child = await createCategory(userId, { parentId: parent.id });
    const ids = [child.id, parent.id];

    const res = await patchSettings({ favoriteCategories: { kind: 'income', ids } }, cookie);

    expect(res.status).toBe(200);
    expect((await readSettings(cookie)).favorites.income).toEqual(ids);
    const { grid } = await readContext(cookie);
    expect(grid.income.slice(0, 2).map((chip) => chip.id)).toEqual(ids);
  });

  it('TASK-149 favoriteCategories reemplaza las favoritas del tipo y no toca las del otro', async () => {
    const { cookie, userId } = await activeAccount();
    const e1 = await createCategory(userId, { kind: 'expense' });
    const e2 = await createCategory(userId, { kind: 'expense' });
    const i1 = await createCategory(userId, { kind: 'income' });
    await patchSettings({ favoriteCategories: { kind: 'expense', ids: [e1.id, e2.id] } }, cookie);
    await patchSettings({ favoriteCategories: { kind: 'income', ids: [i1.id] } }, cookie);

    const res = await patchSettings(
      { favoriteCategories: { kind: 'expense', ids: [e2.id] } },
      cookie,
    );

    expect(res.status).toBe(200);
    expect((await readSettings(cookie)).favorites).toEqual({ expense: [e2.id], income: [i1.id] });
  });

  it('TASK-149 una lista vacía borra las favoritas del tipo', async () => {
    const { cookie, userId } = await activeAccount();
    const e1 = await createCategory(userId, { kind: 'expense' });
    await patchSettings({ favoriteCategories: { kind: 'expense', ids: [e1.id] } }, cookie);

    const res = await patchSettings({ favoriteCategories: { kind: 'expense', ids: [] } }, cookie);

    expect(res.status).toBe(200);
    expect((await readSettings(cookie)).favorites.expense).toEqual([]);
  });

  it('TASK-149 hasta 8 favoritas se guardan y la grilla las muestra todas en su orden', async () => {
    const { cookie, userId } = await activeAccount();
    const ids: string[] = [];
    for (let i = 0; i < 8; i += 1) {
      ids.push((await createCategory(userId, { kind: 'expense' })).id);
    }

    const res = await patchSettings({ favoriteCategories: { kind: 'expense', ids } }, cookie);

    expect(res.status).toBe(200);
    expect((await readSettings(cookie)).favorites.expense).toEqual(ids);
    expect((await readContext(cookie)).grid.expense.map((chip) => chip.id)).toEqual(ids);
  });

  it('TASK-149 más de 8 favoritas responde 400 VALIDATION_ERROR', async () => {
    const { cookie, userId } = await activeAccount();
    const ids: string[] = [];
    for (let i = 0; i < 9; i += 1) {
      ids.push((await createCategory(userId, { kind: 'expense' })).id);
    }

    const res = await patchSettings({ favoriteCategories: { kind: 'expense', ids } }, cookie);

    expect(res.status).toBe(400);
    expect(problem(res).code).toBe('VALIDATION_ERROR');
    expect((await readSettings(cookie)).favorites.expense).toEqual([]);
  });

  it('TASK-149 una categoría archivada como favorita responde 409 CATEGORY_ARCHIVED', async () => {
    const { cookie, userId } = await activeAccount();
    const active = await createCategory(userId, { kind: 'expense' });
    const archived = await createCategory(userId, { kind: 'expense', status: 'archived' });
    await patchSettings({ favoriteCategories: { kind: 'expense', ids: [active.id] } }, cookie);

    const res = await patchSettings(
      { favoriteCategories: { kind: 'expense', ids: [archived.id, active.id] } },
      cookie,
    );

    expect(res.status).toBe(409);
    expect(problem(res).code).toBe('CATEGORY_ARCHIVED');
    expect((await readSettings(cookie)).favorites.expense).toEqual([active.id]);
  });

  it('TASK-149 una categoría de otro tipo como favorita responde 400 VALIDATION_ERROR', async () => {
    const { cookie, userId } = await activeAccount();
    const expense = await createCategory(userId, { kind: 'expense' });
    const income = await createCategory(userId, { kind: 'income' });
    await patchSettings({ favoriteCategories: { kind: 'expense', ids: [expense.id] } }, cookie);

    const res = await patchSettings(
      { favoriteCategories: { kind: 'expense', ids: [expense.id, income.id] } },
      cookie,
    );

    expect(res.status).toBe(400);
    expect(problem(res).code).toBe('VALIDATION_ERROR');
    expect((await readSettings(cookie)).favorites).toEqual({ expense: [expense.id], income: [] });
  });

  it('TASK-149 aislamiento: la categoría de otro usuario no se guarda como favorita', async () => {
    const a = await activeAccount();
    const b = await activeAccount();
    const ofB = await createCategory(b.userId, { kind: 'expense' });

    const res = await patchSettings(
      { favoriteCategories: { kind: 'expense', ids: [ofB.id] } },
      a.cookie,
    );

    expect(res.status).toBeGreaterThanOrEqual(400);
    expect((await readSettings(a.cookie)).favorites.expense).toEqual([]);
    expect((await readSettings(b.cookie)).favorites.expense).toEqual([]);
  });
});
