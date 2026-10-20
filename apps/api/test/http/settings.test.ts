import { createHmac, randomUUID } from 'node:crypto';

import { DEFAULT_DASHBOARD_BLOCKS, type SettingsDto } from '@finanzas/contracts';
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

const sessionCookieOf = (res: { headers: Record<string, unknown> }): string => {
  const raw = res.headers['set-cookie'];
  const list = typeof raw === 'string' ? [raw] : Array.isArray(raw) ? (raw as unknown[]) : [];
  const header = list.find(
    (c): c is string => typeof c === 'string' && c.startsWith(`${COOKIE_NAME}=`),
  );
  if (header === undefined) throw new Error('the response sets no session cookie');
  return header.split(';')[0] ?? '';
};


async function activeAccount(): Promise<{ email: string; cookie: string }> {
  const email = `${randomUUID()}@http-settings.test`;
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
  return { email, cookie: sessionCookieOf(res) };
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

describe('GET y PATCH /api/settings', () => {
  it('TASK-069 GET sin sesión responde 401', async () => {
    expect((await get('/api/settings')).status).toBe(401);
  });

  it('TASK-069 PATCH sin sesión responde 401', async () => {
    expect((await patchSettings({ theme: 'dark' })).status).toBe(401);
  });

  it('TASK-069 GET de una cuenta nueva devuelve los valores por defecto', async () => {
    const { cookie } = await activeAccount();
    const s = await readSettings(cookie);
    expect(s.dashboardBlocks).toEqual(DEFAULT_DASHBOARD_BLOCKS);
    expect(s.defaultAccountId).toBeNull();
    expect(s.favorites).toEqual({ expense: [], income: [] });
    expect(s.sidebarCollapsed).toBe(false);
  });

  it('RF-M9-01 un cambio guardado se lee igual desde otra sesión del mismo usuario', async () => {
    const { email, cookie } = await activeAccount();
    const dashboardBlocks = [...DEFAULT_DASHBOARD_BLOCKS]
      .reverse()
      .map((b, i) => ({ ...b, visible: i % 2 === 0 }));
    const res = await patchSettings(
      {
        theme: 'dark',
        numberFormat: 'comma_dot',
        dateFormat: 'iso',
        weekStart: 'sunday',
        alwaysShowNote: true,
        dashboardBlocks,
      },
      cookie,
    );
    expect(res.status).toBe(200);
    const other = await post('/api/auth/sign-in', { email, password: PASSWORD });
    expect(other.status).toBe(200);
    const s = await readSettings(sessionCookieOf(other));
    expect(s).toMatchObject({
      theme: 'dark',
      numberFormat: 'comma_dot',
      dateFormat: 'iso',
      weekStart: 'sunday',
      alwaysShowNote: true,
    });
    expect(s.dashboardBlocks).toEqual(dashboardBlocks);
  });

  it('RF-M9-01 un PATCH parcial no cambia los demás ajustes', async () => {
    const { cookie } = await activeAccount();
    await patchSettings({ theme: 'light', weekStart: 'sunday' }, cookie);
    await patchSettings({ dateFormat: 'short_text' }, cookie);
    expect(await readSettings(cookie)).toMatchObject({
      theme: 'light',
      weekStart: 'sunday',
      dateFormat: 'short_text',
    });
  });

  it('RF-M2-09 sidebarCollapsed se guarda en la cuenta', async () => {
    const { email, cookie } = await activeAccount();
    const res = await patchSettings({ sidebarCollapsed: true }, cookie);
    expect(res.status).toBe(200);
    const rows = await testPrisma().$queryRaw<{ n: bigint }[]>`
      SELECT count(*) AS n FROM user_settings s JOIN auth_user u ON u.id = s.user_id
      WHERE u.email = ${email} AND s.sidebar_collapsed = true`;
    expect(Number(rows[0]?.n)).toBe(1);
    expect((await readSettings(cookie)).sidebarCollapsed).toBe(true);
  });

  it('EC-M9-01 con dos PATCH seguidos gana el último', async () => {
    const { cookie } = await activeAccount();
    expect((await patchSettings({ theme: 'dark', sidebarCollapsed: true }, cookie)).status).toBe(
      200,
    );
    expect((await patchSettings({ theme: 'light', sidebarCollapsed: false }, cookie)).status).toBe(
      200,
    );
    expect(await readSettings(cookie)).toMatchObject({ theme: 'light', sidebarCollapsed: false });
  });

  it('RNF-08 dos PATCH simultáneos dejan uno de los dos valores completo', async () => {
    const { cookie } = await activeAccount();
    const [a, b] = await Promise.all([
      patchSettings({ theme: 'dark' }, cookie),
      patchSettings({ theme: 'light' }, cookie),
    ]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(['dark', 'light']).toContain((await readSettings(cookie)).theme);
  });

  it('TASK-069 PATCH con un valor inválido responde 400 VALIDATION_ERROR', async () => {
    const { cookie } = await activeAccount();
    const res = await patchSettings({ theme: 'neon' }, cookie);
    expect(res.status).toBe(400);
    expect(problem(res).code).toBe('VALIDATION_ERROR');
  });

  it('TASK-069 PATCH con claves desconocidas responde 400 VALIDATION_ERROR', async () => {
    const { cookie } = await activeAccount();
    const res = await patchSettings({ userId: randomUUID() }, cookie);
    expect(res.status).toBe(400);
    expect(problem(res).code).toBe('VALIDATION_ERROR');
  });

  it('TASK-069 aislamiento: un usuario no ve ni cambia los ajustes de otro', async () => {
    const a = await activeAccount();
    const b = await activeAccount();
    await patchSettings({ theme: 'dark', sidebarCollapsed: true, weekStart: 'sunday' }, a.cookie);
    const sb = await readSettings(b.cookie);
    expect(sb).toMatchObject({ sidebarCollapsed: false });
    expect(sb.theme).not.toBe('dark');
    await patchSettings({ theme: 'light' }, b.cookie);
    expect(await readSettings(a.cookie)).toMatchObject({
      theme: 'dark',
      sidebarCollapsed: true,
      weekStart: 'sunday',
    });
  });
});
