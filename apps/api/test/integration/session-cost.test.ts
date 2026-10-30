import { createHmac, randomUUID } from 'node:crypto';

import type { Express } from 'express';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { buildContainer, createApp, type Container } from '../../src/composition/container.js';
import { parseEnv } from '../../src/infrastructure/config/env.js';
import { disconnectTestPrisma, testPrisma } from './setup/db.js';

/**
 * Cost of the session of an authenticated request (plan §4.0, "Sesión en una consulta"; RNF-29).
 * The real app runs over the test database with fake integrations. The number of database
 * operations of a response comes from its `Server-Timing` header (`queries`, TASK-254).
 * `GET /api/me` runs exactly one operation in its controller (the profile), so its total is the
 * session cost plus one.
 */
const WEB_ORIGIN = 'http://localhost:5173';
const COOKIE_NAME = '__Secure-better-auth.session_token';
const HMAC_SECRET = 'hmac-secret-value-0123456789abcdef0123456789';
const PASSWORD = 'Clave-segura-123';
const NEW_PASSWORD = 'Otra-clave-segura-456';

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

beforeAll(() => {
  container = buildContainer(parseEnv(envSource()));
  app = createApp(container);
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

const get = (path: string, cookie: string, extra: Record<string, string> = {}) =>
  request(app).get(path).set('Cookie', cookie).set(extra);

const TICKET_COOKIE = '__Secure-signup-ticket';

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

/** The number of database operations the response reports in `Server-Timing`. */
const queriesOf = (res: { headers: Record<string, unknown> }): number => {
  const header = res.headers['server-timing'];
  const match = /queries;desc="(\d+)"/.exec(typeof header === 'string' ? header : '');
  expect(match, `Server-Timing sin queries: ${String(header)}`).not.toBeNull();
  return Number(match?.[1]);
};

interface Account {
  email: string;
  userId: string;
  /** Device A: the session that confirmed the account. */
  cookie: string;
}

async function activeAccount(): Promise<Account> {
  const email = `${randomUUID()}@integration-session-cost.test`;
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

/** Device B: signs in again with the same credentials. */
async function secondDevice(email: string, password = PASSWORD): Promise<string> {
  const res = await post('/api/auth/sign-in', { email, password });
  expect(res.status).toBe(200);
  return sessionCookieOf(res);
}

/** Sets the `last_activity_at` of every session of the user to `interval` ago. */
async function ageActivity(userId: string, interval: string): Promise<void> {
  await testPrisma().$executeRawUnsafe(
    `UPDATE auth_session SET last_activity_at = now() - $1::interval WHERE user_id = $2::uuid`,
    interval,
    userId,
  );
}

async function activityOf(userId: string): Promise<Date[]> {
  const rows = await testPrisma().$queryRaw<{ at: Date }[]>`
    SELECT last_activity_at AS at FROM auth_session WHERE user_id = ${userId}::uuid
    ORDER BY created_at, id`;
  return rows.map((row) => row.at);
}

describe('costo de la sesión de una petición autenticada', () => {
  it('RNF-29 GET /api/me con la sesión al día ejecuta 1 consulta de sesión más la del perfil', async () => {
    const { cookie } = await activeAccount();
    await get('/api/me', cookie); // warms the connection and the one-off work

    const res = await get('/api/me', cookie);

    expect(res.status).toBe(200);
    expect(queriesOf(res)).toBe(2);
  });

  it('RNF-29 el costo de la sesión no crece con las peticiones: tres seguidas cuestan lo mismo', async () => {
    const { cookie } = await activeAccount();
    await get('/api/me', cookie);

    const counts: number[] = [];
    for (let i = 0; i < 3; i += 1) {
      counts.push(queriesOf(await get('/api/me', cookie)));
    }

    expect(counts).toEqual([2, 2, 2]);
  });

  it('RNF-29 una petición con la actividad vieja suma una sola escritura (touch) a la consulta de sesión', async () => {
    const { userId, cookie } = await activeAccount();
    await get('/api/me', cookie);
    await ageActivity(userId, '10 minutes');

    const res = await get('/api/me', cookie);

    expect(res.status).toBe(200);
    expect(queriesOf(res)).toBe(3);
  });

  it('RNF-29 una cookie con un token desconocido cuesta una sola consulta y da SESSION_EXPIRED', async () => {
    const res = await get(
      '/api/me',
      `${COOKIE_NAME}=${encodeURIComponent('token-que-no-existe.firma')}`,
    );

    expect(res.status).toBe(401);
    expect(problem(res).code).toBe('SESSION_EXPIRED');
    expect(queriesOf(res)).toBe(1);
  });

  it('RNF-29 una petición sin cookie no consulta la base', async () => {
    const res = await request(app).get('/api/me');

    expect(res.status).toBe(401);
    expect(problem(res).code).toBe('SESSION_EXPIRED');
    expect(queriesOf(res)).toBe(0);
  });
});

describe('vigencia de la sesión sobre la base', () => {
  it('RF-M1-07 una petición normal con 10 minutos de inactividad renueva last_activity_at', async () => {
    const { userId, cookie } = await activeAccount();
    await ageActivity(userId, '10 minutes');
    const before = (await activityOf(userId))[0];

    const res = await get('/api/me', cookie);

    expect(res.status).toBe(200);
    const after = (await activityOf(userId))[0];
    expect(after?.getTime()).toBeGreaterThan((before?.getTime() ?? 0) + 9 * 60_000);
    expect(Date.now() - (after?.getTime() ?? 0)).toBeLessThan(60_000);
  });

  it('RF-M1-07 una petición con X-Background no renueva la actividad ni escribe en la base', async () => {
    const { userId, cookie } = await activeAccount();
    await get('/api/me', cookie);
    await ageActivity(userId, '10 minutes');
    const before = await activityOf(userId);

    const res = await get('/api/me', cookie, { 'X-Background': '1' });

    expect(res.status).toBe(200);
    expect(await activityOf(userId)).toEqual(before);
    expect(queriesOf(res)).toBe(2);
  });

  it('RF-M1-07 con 31 días de inactividad la sesión se rechaza con SESSION_EXPIRED y no se renueva', async () => {
    const { userId, cookie } = await activeAccount();
    await ageActivity(userId, '31 days');
    const before = await activityOf(userId);

    const res = await get('/api/me', cookie);

    expect(res.status).toBe(401);
    expect(problem(res).code).toBe('SESSION_EXPIRED');
    expect(queriesOf(res)).toBe(1);
    expect(await activityOf(userId)).toEqual(before);
  });

  it('RF-M1-07 con 29 días de inactividad la sesión sigue vigente', async () => {
    const { userId, cookie } = await activeAccount();
    await ageActivity(userId, '29 days');

    const res = await get('/api/me', cookie);

    expect(res.status).toBe(200);
  });

  it('RF-M1-07 dos dispositivos con sesión simultánea responden a la vez', async () => {
    const { email, cookie } = await activeAccount();
    const second = await secondDevice(email);

    const [a, b] = await Promise.all([get('/api/me', cookie), get('/api/me', second)]);

    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
  });

  it('TASK-255 una sesión con expires_at en el pasado se rechaza con SESSION_EXPIRED', async () => {
    const { userId, cookie } = await activeAccount();
    await testPrisma().$executeRaw`
      UPDATE auth_session SET expires_at = now() - interval '1 minute'
       WHERE user_id = ${userId}::uuid`;

    const res = await get('/api/me', cookie);

    expect(res.status).toBe(401);
    expect(problem(res).code).toBe('SESSION_EXPIRED');
  });

  it('TASK-255 la zona horaria del perfil viaja con la sesión sin una consulta aparte', async () => {
    const { cookie } = await activeAccount();
    const patch = await request(app)
      .patch('/api/me')
      .set('Origin', WEB_ORIGIN)
      .set('Cookie', cookie)
      .send({ timezone: 'America/Sao_Paulo' });
    expect(patch.status).toBe(200);

    const res = await get('/api/me', cookie);

    expect(res.status).toBe(200);
    expect((res.body as { timezone?: string }).timezone).toBe('America/Sao_Paulo');
    expect(queriesOf(res)).toBe(2);
  });
});

describe('revocar una sesión surte efecto en la siguiente petición (sin caché)', () => {
  it('EC-M1-05 tras cambiar la contraseña en A, la petición siguiente de B recibe SESSION_EXPIRED', async () => {
    const { email, cookie: deviceA } = await activeAccount();
    const deviceB = await secondDevice(email);
    expect((await get('/api/me', deviceB)).status).toBe(200);

    const change = await post(
      '/api/auth/password/change',
      { currentPassword: PASSWORD, newPassword: NEW_PASSWORD },
      deviceA,
    );
    expect(change.status).toBe(204);

    const res = await get('/api/me', deviceB);
    expect(res.status).toBe(401);
    expect(problem(res).code).toBe('SESSION_EXPIRED');
    expect(queriesOf(res)).toBe(1);
    expect((await get('/api/me', deviceA)).status).toBe(200);
  });

  it('EC-M1-06 tras eliminar la cuenta en A, la petición siguiente de B recibe SESSION_EXPIRED', async () => {
    const { email, cookie: deviceA } = await activeAccount();
    const deviceB = await secondDevice(email);
    expect((await get('/api/me', deviceB)).status).toBe(200);

    const removal = await post(
      '/api/me/delete',
      { password: PASSWORD, confirmation: 'ELIMINAR' },
      deviceA,
    );
    expect(removal.status).toBe(204);

    const res = await get('/api/me', deviceB);
    expect(res.status).toBe(401);
    expect(problem(res).code).toBe('SESSION_EXPIRED');
    expect(queriesOf(res)).toBe(1);
  });

  it('EC-M1-05 cerrar todas las sesiones en A hace que la siguiente petición de B reciba SESSION_EXPIRED', async () => {
    const { email, cookie: deviceA } = await activeAccount();
    const deviceB = await secondDevice(email);
    expect((await get('/api/me', deviceB)).status).toBe(200);

    expect((await post('/api/auth/sign-out-all', {}, deviceA)).status).toBe(204);

    const res = await get('/api/me', deviceB);
    expect(res.status).toBe(401);
    expect(problem(res).code).toBe('SESSION_EXPIRED');
  });

  it('EC-M1-05 una sesión borrada de la base deja de valer en la petición inmediata, sin esperar', async () => {
    const { userId, cookie } = await activeAccount();
    expect((await get('/api/me', cookie)).status).toBe(200);

    await testPrisma().$executeRaw`DELETE FROM auth_session WHERE user_id = ${userId}::uuid`;

    const res = await get('/api/me', cookie);
    expect(res.status).toBe(401);
    expect(problem(res).code).toBe('SESSION_EXPIRED');
  });
});
