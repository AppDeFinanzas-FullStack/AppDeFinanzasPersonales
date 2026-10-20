import { createHmac, randomUUID } from 'node:crypto';

import type { Express } from 'express';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { buildContainer, createApp, type Container } from '../../src/composition/container.js';
import { parseEnv } from '../../src/infrastructure/config/env.js';
import { disconnectTestPrisma, testPrisma } from '../integration/setup/db.js';

/**
 * `POST /api/me/delete` (plan §4.1.2, §4.1.3, §3.8). Accounts are made through `sign-up` and
 * `confirm` over the test database with fake integrations, as in `me.test.ts`.
 */
const WEB_ORIGIN = 'http://localhost:5173';
const COOKIE_NAME = '__Secure-better-auth.session_token';
const HMAC_SECRET = 'hmac-secret-value-0123456789abcdef0123456789';
const PASSWORD = 'Clave-segura-123';
const WAIT_MS = 400;

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

async function activeAccount(): Promise<{ email: string; userId: string; cookie: string }> {
  const email = `${randomUUID()}@http-me-delete.test`;
  usedEmails.add(email);
  const up = await post('/api/auth/sign-up', {
    name: 'Ana Pérez',
    email,
    password: PASSWORD,
    acceptTerms: true,
  });
  expect(up.status).toBe(202);
  const db = testPrisma();
  const links = await db.$queryRaw<{ link: string | null }[]>`
    SELECT payload->>'link' AS link FROM email_outbox
    WHERE to_address = ${email} AND kind = 'confirm'::email_kind
    ORDER BY created_at DESC, id DESC LIMIT 1`;
  const token = /[A-Za-z0-9_-]{43}/.exec(links[0]?.link ?? '')?.[0];
  if (token === undefined) throw new Error('no confirmation token');
  const res = await post('/api/auth/confirm', { token });
  expect(res.status).toBe(200);
  const ids = await db.$queryRaw<{ id: string }[]>`
    SELECT id::text AS id FROM auth_user WHERE email = ${email}`;
  return { email, userId: ids[0]?.id ?? '', cookie: sessionCookieOf(res) };
}

/** A second device: signs in again with the same credentials. */
async function secondDevice(email: string): Promise<string> {
  const res = await post('/api/auth/sign-in', { email, password: PASSWORD });
  expect(res.status).toBe(200);
  return sessionCookieOf(res);
}

/** Seeds an account row (and its currency) for the user, outside of the API. */
async function seedAccount(userId: string): Promise<void> {
  const db = testPrisma();
  await db.$executeRaw`
    INSERT INTO currency (user_id, code, symbol) VALUES (${userId}::uuid, 'BOB', 'Bs')
    ON CONFLICT DO NOTHING`;
  await db.$executeRaw`
    INSERT INTO account (id, user_id, type, name, currency_code, initial_balance_date, color,
                         icon, sort_order)
    VALUES (${randomUUID()}::uuid, ${userId}::uuid, 'cash', 'Efectivo', 'BOB', CURRENT_DATE,
            '#112233', 'wallet', 0)`;
}

/** Rows that belong to the user in every table that has a `user_id` column, plus `auth_user`. */
async function rowsOf(userId: string): Promise<Record<string, number>> {
  const db = testPrisma();
  const tables = await db.$queryRaw<{ table_name: string }[]>`
    SELECT c.table_name FROM information_schema.columns c
    JOIN information_schema.tables t
      ON t.table_schema = c.table_schema AND t.table_name = c.table_name
    WHERE c.table_schema = 'public' AND c.column_name = 'user_id' AND t.table_type = 'BASE TABLE'`;
  const counts: Record<string, number> = {};
  for (const { table_name: name } of tables) {
    const rows = await db.$queryRawUnsafe<{ n: number }[]>(
      `SELECT count(*)::int AS n FROM "${name}" WHERE user_id = $1::uuid`,
      userId,
    );
    counts[name] = rows[0]?.n ?? 0;
  }
  const users = await db.$queryRaw<{ n: number }[]>`
    SELECT count(*)::int AS n FROM auth_user WHERE id = ${userId}::uuid`;
  counts['auth_user'] = users[0]?.n ?? 0;
  return counts;
}

const total = (counts: Record<string, number>) =>
  Object.values(counts).reduce((sum, n) => sum + n, 0);

async function deletedMails(email: string): Promise<number> {
  const rows = await testPrisma().$queryRaw<{ n: number }[]>`
    SELECT count(*)::int AS n FROM email_outbox
    WHERE to_address = ${email} AND kind = 'account_deleted'::email_kind`;
  return rows[0]?.n ?? 0;
}

const CONFIRMED = { password: PASSWORD, confirmation: 'ELIMINAR' };

describe('POST /api/me/delete', () => {
  it('RF-M1-15 Eliminar la cuenta: borra todos los datos, cierra las sesiones y encola account_deleted', async () => {
    const { email, userId, cookie } = await activeAccount();
    await seedAccount(userId);
    const before = await rowsOf(userId);
    expect(before['account']).toBe(1);
    expect(before['auth_session']).toBeGreaterThan(0);

    const res = await post('/api/me/delete', CONFIRMED, cookie);

    expect(res.status).toBe(204);
    expect(total(await rowsOf(userId))).toBe(0);
    expect(await deletedMails(email)).toBe(1);
    const next = await get('/api/me', cookie);
    expect(next.status).toBe(401);
    expect(problem(next).code).toBe('SESSION_EXPIRED');
  });

  it('RNF-25 el correo account_deleted queda dirigido al dueño en la bandeja de salida', async () => {
    const { email, cookie } = await activeAccount();

    const res = await post('/api/me/delete', CONFIRMED, cookie);

    expect(res.status).toBe(204);
    const rows = await testPrisma().$queryRaw<{ status: string }[]>`
      SELECT status::text AS status FROM email_outbox
      WHERE to_address = ${email} AND kind = 'account_deleted'::email_kind`;
    expect(rows).toHaveLength(1);
  });

  it('RNF-16 la eliminación es inmediata: el correo ya no puede iniciar sesión', async () => {
    const { email, cookie } = await activeAccount();
    await post('/api/me/delete', CONFIRMED, cookie);

    const res = await post('/api/auth/sign-in', { email, password: PASSWORD });

    expect(res.status).toBe(401);
    expect(problem(res).code).toBe('INVALID_CREDENTIALS');
  });

  it('EC-M1-08 con una contraseña incorrecta responde 401 INVALID_PASSWORD y no borra nada', async () => {
    const { email, userId, cookie } = await activeAccount();
    await seedAccount(userId);
    const before = await rowsOf(userId);

    const res = await post(
      '/api/me/delete',
      { password: 'Otra-clave-999', confirmation: 'ELIMINAR' },
      cookie,
    );

    expect(res.status).toBe(401);
    expect(problem(res).code).toBe('INVALID_PASSWORD');
    expect(await rowsOf(userId)).toEqual(before);
    expect(await deletedMails(email)).toBe(0);
    expect((await get('/api/me', cookie)).status).toBe(200);
  });

  it.each(['eliminar', 'ELIMINAR ', 'BORRAR', ''])(
    'EC-M1-08 con la palabra %j responde 422 CONFIRMATION_MISMATCH y no borra nada',
    async (word) => {
      const { email, userId, cookie } = await activeAccount();
      await seedAccount(userId);
      const before = await rowsOf(userId);

      const res = await post('/api/me/delete', { password: PASSWORD, confirmation: word }, cookie);

      expect(res.status).toBe(422);
      expect(problem(res).code).toBe('CONFIRMATION_MISMATCH');
      expect(await rowsOf(userId)).toEqual(before);
      expect(await deletedMails(email)).toBe(0);
      expect((await get('/api/me', cookie)).status).toBe(200);
    },
  );

  it('EC-M1-06 la sesión de otro dispositivo recibe SESSION_EXPIRED en su siguiente acción', async () => {
    const { email, cookie } = await activeAccount();
    const other = await secondDevice(email);
    expect((await get('/api/me', other)).status).toBe(200);

    const res = await post('/api/me/delete', CONFIRMED, cookie);

    expect(res.status).toBe(204);
    const next = await get('/api/me', other);
    expect(next.status).toBe(401);
    expect(problem(next).code).toBe('SESSION_EXPIRED');
  });

  it('RF-M1-15 sin sesión responde 401 SESSION_EXPIRED', async () => {
    const res = await post('/api/me/delete', CONFIRMED);

    expect(res.status).toBe(401);
    expect(problem(res).code).toBe('SESSION_EXPIRED');
  });

  it('RF-M1-15 un job que toma el bloqueo del usuario no crea datos después de la eliminación', async () => {
    const { userId, cookie } = await activeAccount();
    const db = testPrisma();
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let locked: () => void = () => undefined;
    const lockTaken = new Promise<void>((resolve) => {
      locked = resolve;
    });
    // The "job": holds the per-user lock, creates data, and commits only when released.
    const job = db.$transaction(
      async (tx) => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('user:' || ${userId}::text))`;
        locked();
        await gate;
        await tx.$executeRaw`
          INSERT INTO currency (user_id, code, symbol) VALUES (${userId}::uuid, 'BOB', 'Bs')
          ON CONFLICT DO NOTHING`;
        await tx.$executeRaw`
          INSERT INTO account (id, user_id, type, name, currency_code, initial_balance_date,
                               color, icon, sort_order)
          VALUES (${randomUUID()}::uuid, ${userId}::uuid, 'cash', 'Del job', 'BOB', CURRENT_DATE,
                  '#112233', 'wallet', 0)`;
      },
      { timeout: 20_000 },
    );
    await lockTaken;

    let finished = false;
    const deletion = post('/api/me/delete', CONFIRMED, cookie).then((res) => {
      finished = true;
      return res;
    });
    await new Promise((resolve) => setTimeout(resolve, WAIT_MS));
    expect(finished).toBe(false);

    release();
    await job;
    const res = await deletion;

    expect(res.status).toBe(204);
    expect(total(await rowsOf(userId))).toBe(0);
  });
});
