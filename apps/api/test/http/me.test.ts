import { createHmac, randomUUID } from 'node:crypto';

import { MeDto } from '@finanzas/contracts';
import type { Express } from 'express';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { buildContainer, createApp, type Container } from '../../src/composition/container.js';
import { parseEnv } from '../../src/infrastructure/config/env.js';
import { disconnectTestPrisma, testPrisma } from '../integration/setup/db.js';

/**
 * `GET` and `PATCH /api/me` (plan §4.1.2). Accounts are made through `sign-up` and `confirm`
 * over the test database with fake integrations, as in `auth.test.ts`.
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

const patch = (body: object, cookie?: string) => {
  const req = request(app).patch('/api/me').set('Origin', WEB_ORIGIN);
  if (cookie !== undefined) req.set('Cookie', cookie);
  return req.send(body);
};

const TICKET_COOKIE = '__Secure-signup-ticket';

/** The `name=value` pair of the signup ticket cookie that the sign-up sets (RF-M1-18). */
const ticketCookieOf = (res: { headers: Record<string, unknown> }): string => {
  const raw = res.headers['set-cookie'];
  const list = typeof raw === 'string' ? [raw] : Array.isArray(raw) ? (raw as unknown[]) : [];
  const header = list.find(
    (c): c is string => typeof c === 'string' && c.startsWith(`${TICKET_COOKIE}=`),
  );
  if (header === undefined) throw new Error('the sign-up sets no ticket cookie');
  return header.split(';')[0] ?? '';
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

async function activeAccount(
  name = 'Ana Pérez',
): Promise<{ email: string; userId: string; cookie: string }> {
  const email = `${randomUUID()}@http-me.test`;
  usedEmails.add(email);
  const up = await post('/api/auth/sign-up', {
    name,
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
  const confirmed = await post('/api/auth/confirm', { token });
  expect(confirmed.status).toBe(200);
  // The link only confirms; the session comes from the ticket of the sign-up (RF-M1-18).
  const res = await request(app)
    .post('/api/auth/confirmation/status')
    .set('Origin', WEB_ORIGIN)
    .set('Cookie', ticketCookieOf(up));
  expect(res.status).toBe(200);
  const ids = await db.$queryRaw<{ id: string }[]>`
    SELECT id::text AS id FROM auth_user WHERE email = ${email}`;
  return { email, userId: ids[0]?.id ?? '', cookie: sessionCookieOf(res) };
}

describe('GET /api/me', () => {
  it('RN-09 devuelve el MeDto de la sesión, con release y el estado del Onboarding', async () => {
    const { email, userId, cookie } = await activeAccount();

    const res = await get('/api/me', cookie);

    expect(res.status).toBe(200);
    const me = MeDto.parse(res.body);
    expect(me.id).toBe(userId);
    expect(me.email).toBe(email);
    expect(me.name).toBe('Ana Pérez');
    expect(me.release).toBe('1.0');
    expect(me.locale).toBe('es-BO');
    expect(me.onboarding.completed).toBe(false);
  });

  it('RN-09 la respuesta usa solo la sesión: un id del cliente en la consulta se ignora', async () => {
    const mine = await activeAccount('Ana Pérez');
    const other = await activeAccount('Otro Usuario');

    const res = await get(`/api/me?id=${other.userId}&userId=${other.userId}`, mine.cookie);

    expect(res.status).toBe(200);
    expect(MeDto.parse(res.body).id).toBe(mine.userId);
  });

  it('RN-09 sin sesión responde 401 SESSION_EXPIRED', async () => {
    const res = await get('/api/me');

    expect(res.status).toBe(401);
    expect(problem(res).code).toBe('SESSION_EXPIRED');
  });
});

describe('PATCH /api/me', () => {
  it('RF-M1-11 la zona horaria se puede cambiar', async () => {
    const { cookie } = await activeAccount();

    const res = await patch({ timezone: 'America/Sao_Paulo' }, cookie);

    expect(res.status).toBe(200);
    expect(MeDto.parse(res.body).timezone).toBe('America/Sao_Paulo');
    const after = await get('/api/me', cookie);
    expect(MeDto.parse(after.body).timezone).toBe('America/Sao_Paulo');
  });

  it('RF-M1-11 se puede cambiar el nombre y se guarda recortado', async () => {
    const { cookie, userId } = await activeAccount();

    const res = await patch({ name: '  María López  ' }, cookie);

    expect(res.status).toBe(200);
    expect(MeDto.parse(res.body).name).toBe('María López');
    const rows = await testPrisma().$queryRaw<{ name: string }[]>`
      SELECT name FROM auth_user WHERE id = ${userId}::uuid`;
    expect(rows[0]?.name).toBe('María López');
  });

  it('RF-M1-12 cambiar la zona horaria no altera la fecha de un movimiento ya guardado', async () => {
    const { cookie, userId } = await activeAccount();
    const db = testPrisma();
    const categories = await db.$queryRaw<{ id: string }[]>`
      SELECT id::text AS id FROM category
      WHERE user_id = ${userId}::uuid AND kind = 'expense' LIMIT 1`;
    const categoryId = categories[0]?.id;
    if (categoryId === undefined) throw new Error('the user has no expense category');
    const txId = randomUUID();
    await db.$executeRaw`
      INSERT INTO ledger_transaction (id, user_id, kind, date, category_id, rate_cur_bob)
      VALUES (${txId}::uuid, ${userId}::uuid, 'expense', DATE '2026-03-15',
              ${categoryId}::uuid, 1)`;

    const res = await patch({ timezone: 'Pacific/Auckland' }, cookie);

    expect(res.status).toBe(200);
    const rows = await db.$queryRaw<{ date: string }[]>`
      SELECT to_char(date, 'YYYY-MM-DD') AS date FROM ledger_transaction
      WHERE id = ${txId}::uuid`;
    expect(rows[0]?.date).toBe('2026-03-15');
  });

  it('RF-M1-13 enviar email da 400 VALIDATION_ERROR y no cambia el correo', async () => {
    const { email, cookie, userId } = await activeAccount();

    const res = await patch({ email: `${randomUUID()}@http-me.test` }, cookie);

    expect(res.status).toBe(400);
    expect(problem(res).code).toBe('VALIDATION_ERROR');
    const rows = await testPrisma().$queryRaw<{ email: string }[]>`
      SELECT email FROM auth_user WHERE id = ${userId}::uuid`;
    expect(rows[0]?.email).toBe(email);
  });

  it('RF-M1-13 enviar email junto con otros campos tampoco cambia nada', async () => {
    const { cookie } = await activeAccount();

    const res = await patch({ name: 'Nuevo Nombre', email: 'otro@http-me.test' }, cookie);

    expect(res.status).toBe(400);
    expect(problem(res).code).toBe('VALIDATION_ERROR');
    const after = await get('/api/me', cookie);
    expect(MeDto.parse(after.body).name).toBe('Ana Pérez');
  });

  it('RN-09 un id en el cuerpo da VALIDATION_ERROR y no toca a otro usuario', async () => {
    const mine = await activeAccount();
    const other = await activeAccount('Otro Usuario');

    const res = await patch({ id: other.userId, name: 'Intruso' }, mine.cookie);

    expect(res.status).toBe(400);
    expect(problem(res).code).toBe('VALIDATION_ERROR');
    const rows = await testPrisma().$queryRaw<{ name: string }[]>`
      SELECT name FROM auth_user WHERE id = ${other.userId}::uuid`;
    expect(rows[0]?.name).toBe('Otro Usuario');
  });

  it('RN-09 el PATCH cambia solo al usuario de la sesión', async () => {
    const mine = await activeAccount();
    const other = await activeAccount('Otro Usuario');

    const res = await patch({ name: 'Nombre Nuevo' }, mine.cookie);

    expect(res.status).toBe(200);
    expect(MeDto.parse(res.body).id).toBe(mine.userId);
    const rows = await testPrisma().$queryRaw<{ name: string }[]>`
      SELECT name FROM auth_user WHERE id = ${other.userId}::uuid`;
    expect(rows[0]?.name).toBe('Otro Usuario');
  });

  it('RN-09 sin sesión responde 401 SESSION_EXPIRED', async () => {
    const res = await patch({ name: 'Sin Sesión' });

    expect(res.status).toBe(401);
    expect(problem(res).code).toBe('SESSION_EXPIRED');
  });
});
