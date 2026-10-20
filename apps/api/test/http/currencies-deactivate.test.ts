import type { Express } from 'express';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { buildContainer, createApp, type Container } from '../../src/composition/container.js';
import { parseEnv } from '../../src/infrastructure/config/env.js';
import { disconnectTestPrisma, testPrisma } from '../integration/setup/db.js';

/**
 * `POST /api/currencies/:code/deactivate` and `POST /api/currencies/:code/activate {rate}` (plan
 * §4.3.2, §4.3.3) and the shared `CurrencyUsage` registry (plan §4.0), over the test database with
 * fake integrations. The plan fixes the routes, the `custom_rate` event of a reactivation and the
 * error codes; it does not fix the success status, so a success is any 2xx answer.
 *
 * `CurrencyUsage.register(module, check)` is the registry every module fills in its own phase; the
 * test registers its own usage, which answers "in use" only for the users and codes it marks.
 */
const WEB_ORIGIN = 'http://localhost:5173';
const COOKIE_NAME = '__Secure-better-auth.session_token';
const TEST_MODULE = 'test-usage';

const envSource = (): Record<string, string> => ({
  NODE_ENV: 'test',
  PORT: '3000',
  DATABASE_URL: process.env['TEST_DATABASE_URL'] ?? '',
  AUTH_SECRET: 'auth-secret-value-0123456789abcdef0123456789',
  HMAC_SECRET: 'hmac-secret-value-0123456789abcdef0123456789',
  JOBS_SECRET: 'jobs-secret-value-0123456789abcdef0123456789',
  RESEND_API_KEY: 're_resend-key-value-0123456789',
  RELEASE: '1.0',
  WEB_ORIGIN,
  INTEGRATIONS: 'fake',
});

interface Problem {
  code?: string;
  status?: number;
  data?: { usedBy?: unknown };
}
const problem = (res: { body: unknown }) => res.body as Problem;

/** The part of `application/shared/currency-usage.ts` the test uses. */
interface CurrencyUsageRegistry {
  register(
    module: string,
    check: (tx: unknown, userId: string, code: string) => Promise<boolean>,
  ): void;
}

interface Account {
  cookie: string;
  userId: string;
}

interface CurrencyRow {
  code: string;
  status: string;
}

interface RateEventRow {
  currencyCode: string | null;
  value: string | null;
}

const db = testPrisma();
let container: Container;
let app: Express;
const usedEmails: string[] = [];

/** `userId:code` pairs the test usage reports as in use. */
const inUse = new Set<string>();
const markInUse = (userId: string, code: string) => inUse.add(`${userId}:${code}`);

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
  return { cookie: sessionCookieOf(res), userId };
}

const postCurrency = (body: object, cookie: string) =>
  request(app)
    .post('/api/currencies')
    .set('Origin', WEB_ORIGIN)
    .set('Cookie', cookie)
    .send(body);

const deactivate = (code: string, cookie: string | null) => {
  const req = request(app).post(`/api/currencies/${code}/deactivate`).set('Origin', WEB_ORIGIN);
  if (cookie !== null) req.set('Cookie', cookie);
  return req;
};

const activate = (code: string, body: object, cookie: string | null) => {
  const req = request(app).post(`/api/currencies/${code}/activate`).set('Origin', WEB_ORIGIN);
  if (cookie !== null) req.set('Cookie', cookie);
  return req.send(body);
};

const patchFxSettings = (body: object, cookie: string) =>
  request(app)
    .patch('/api/fx-settings')
    .set('Origin', WEB_ORIGIN)
    .set('Cookie', cookie)
    .send(body);

const expectSuccess = (res: { status: number }) => {
  expect(res.status).toBeGreaterThanOrEqual(200);
  expect(res.status).toBeLessThan(300);
};

async function statusOf(userId: string, code: string): Promise<string | undefined> {
  const rows = await db.$queryRaw<CurrencyRow[]>`
    SELECT code::text AS code, status::text AS status
      FROM currency WHERE user_id = ${userId}::uuid AND code = ${code}`;
  return rows[0]?.status;
}

async function rateEventsOf(userId: string, code: string): Promise<RateEventRow[]> {
  return db.$queryRaw<RateEventRow[]>`
    SELECT currency_code::text AS "currencyCode", value::text AS value
      FROM user_fx_event
     WHERE user_id = ${userId}::uuid AND kind = 'custom_rate' AND currency_code = ${code}
     ORDER BY effective_at, id`;
}

/** A signed-in user with EUR added at Bs 7.50. */
async function withEur(): Promise<Account> {
  const account = await signedIn();
  expectSuccess(await postCurrency({ code: 'EUR', symbol: '€', rate: '7.50' }, account.cookie));
  return account;
}

beforeAll(async () => {
  const usage = (await import('../../src/application/shared/currency-usage.js')) as {
    CurrencyUsage: CurrencyUsageRegistry;
  };
  usage.CurrencyUsage.register(TEST_MODULE, (_tx, userId, code) =>
    Promise.resolve(inUse.has(`${userId}:${code}`)),
  );
  container = await Promise.resolve(buildContainer(parseEnv(envSource())));
  app = await Promise.resolve(createApp(container));
}, 30_000);

afterAll(async () => {
  await sleep(300);
  await db.$executeRaw`DELETE FROM auth_user WHERE email = ANY(${usedEmails}::text[])`;
  await db.$executeRaw`DELETE FROM email_outbox WHERE to_address = ANY(${usedEmails}::text[])`;
  await disconnectTestPrisma();
  await container.prisma.$disconnect();
}, 30_000);

describe('POST /api/currencies/:code/deactivate', () => {
  it('TASK-089 sin sesión responde 401', async () => {
    expect((await deactivate('EUR', null)).status).toBe(401);
  });

  it('TASK-089 desactiva una moneda agregada que no está en uso', async () => {
    const { cookie, userId } = await withEur();

    expectSuccess(await deactivate('EUR', cookie));

    expect(await statusOf(userId, 'EUR')).toBe('inactive');
  });

  it('RF-M3-01 desactivar USD responde 422 SYSTEM_CURRENCY y la deja activa', async () => {
    const { cookie, userId } = await signedIn();

    const res = await deactivate('USD', cookie);

    expect(res.status).toBe(422);
    expect(problem(res).code).toBe('SYSTEM_CURRENCY');
    expect(await statusOf(userId, 'USD')).toBe('active');
  });

  it('RF-M3-01 desactivar BOB responde 422 SYSTEM_CURRENCY y la deja activa', async () => {
    const { cookie, userId } = await withEur();
    expectSuccess(await patchFxSettings({ baseCurrency: 'EUR' }, cookie));

    const res = await deactivate('BOB', cookie);

    expect(res.status).toBe(422);
    expect(problem(res).code).toBe('SYSTEM_CURRENCY');
    expect(await statusOf(userId, 'BOB')).toBe('active');
  });

  it('RF-M3-01 desactivar la moneda base responde 422 BASE_CURRENCY y la deja activa', async () => {
    const { cookie, userId } = await withEur();
    expectSuccess(await patchFxSettings({ baseCurrency: 'EUR' }, cookie));

    const res = await deactivate('EUR', cookie);

    expect(res.status).toBe(422);
    expect(problem(res).code).toBe('BASE_CURRENCY');
    expect(await statusOf(userId, 'EUR')).toBe('active');
  });

  it('EC-M3-05 con un uso registrado de prueba responde 409 CURRENCY_IN_USE con usedBy y la deja activa', async () => {
    const { cookie, userId } = await withEur();
    markInUse(userId, 'EUR');

    const res = await deactivate('EUR', cookie);

    expect(res.status).toBe(409);
    expect(problem(res).code).toBe('CURRENCY_IN_USE');
    expect(problem(res).data?.usedBy).toEqual([TEST_MODULE]);
    expect(await statusOf(userId, 'EUR')).toBe('active');
  });

  it('EC-M3-05 el uso de una moneda no impide desactivar otra moneda del mismo usuario', async () => {
    const { cookie, userId } = await withEur();
    expectSuccess(await postCurrency({ code: 'GBP', symbol: '£', rate: '9.10' }, cookie));
    markInUse(userId, 'EUR');

    expectSuccess(await deactivate('GBP', cookie));

    expect(await statusOf(userId, 'GBP')).toBe('inactive');
    expect(await statusOf(userId, 'EUR')).toBe('active');
  });

  it('EC-M3-05 el uso de la moneda de un usuario no impide que otro desactive la suya', async () => {
    const owner = await withEur();
    const other = await withEur();
    markInUse(owner.userId, 'EUR');

    expectSuccess(await deactivate('EUR', other.cookie));

    expect(await statusOf(other.userId, 'EUR')).toBe('inactive');
    expect(await statusOf(owner.userId, 'EUR')).toBe('active');
  });

  it('TASK-089 una moneda que el usuario no tiene responde 404 NOT_FOUND', async () => {
    const { cookie } = await signedIn();

    const res = await deactivate('JPY', cookie);

    expect(res.status).toBe(404);
    expect(problem(res).code).toBe('NOT_FOUND');
  });

  it('TASK-089 un usuario no puede desactivar la moneda agregada de otro', async () => {
    const owner = await withEur();
    const other = await signedIn();

    const res = await deactivate('EUR', other.cookie);

    expect(res.status).toBe(404);
    expect(problem(res).code).toBe('NOT_FOUND');
    expect(await statusOf(owner.userId, 'EUR')).toBe('active');
  });
});

describe('POST /api/currencies/:code/activate', () => {
  it('TASK-089 sin sesión responde 401', async () => {
    expect((await activate('EUR', { rate: '8.10' }, null)).status).toBe(401);
  });

  it('TASK-089 reactivar con una tasa nueva deja la moneda activa e inserta un custom_rate', async () => {
    const { cookie, userId } = await withEur();
    expectSuccess(await deactivate('EUR', cookie));

    expectSuccess(await activate('EUR', { rate: '8.10' }, cookie));

    expect(await statusOf(userId, 'EUR')).toBe('active');
    expect(await rateEventsOf(userId, 'EUR')).toEqual([
      { currencyCode: 'EUR', value: '7.50' },
      { currencyCode: 'EUR', value: '8.10' },
    ]);
  });

  it('TASK-089 reactivar sin tasa responde 400 VALIDATION_ERROR y la deja inactiva', async () => {
    const { cookie, userId } = await withEur();
    expectSuccess(await deactivate('EUR', cookie));

    const res = await activate('EUR', {}, cookie);

    expect(res.status).toBe(400);
    expect(problem(res).code).toBe('VALIDATION_ERROR');
    expect(await statusOf(userId, 'EUR')).toBe('inactive');
    expect(await rateEventsOf(userId, 'EUR')).toEqual([{ currencyCode: 'EUR', value: '7.50' }]);
  });

  it('TASK-089 reactivar con una tasa menor que Bs 0,01 se rechaza y la deja inactiva', async () => {
    const { cookie, userId } = await withEur();
    expectSuccess(await deactivate('EUR', cookie));

    const res = await activate('EUR', { rate: '0.00' }, cookie);

    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.status).toBeLessThan(500);
    expect(await statusOf(userId, 'EUR')).toBe('inactive');
    expect(await rateEventsOf(userId, 'EUR')).toEqual([{ currencyCode: 'EUR', value: '7.50' }]);
  });

  it('TASK-089 un usuario no puede reactivar la moneda agregada de otro', async () => {
    const owner = await withEur();
    expectSuccess(await deactivate('EUR', owner.cookie));
    const other = await signedIn();

    const res = await activate('EUR', { rate: '8.10' }, other.cookie);

    expect(res.status).toBe(404);
    expect(problem(res).code).toBe('NOT_FOUND');
    expect(await statusOf(owner.userId, 'EUR')).toBe('inactive');
    expect(await rateEventsOf(owner.userId, 'EUR')).toEqual([
      { currencyCode: 'EUR', value: '7.50' },
    ]);
  });
});
