import { CurrencyDto } from '@finanzas/contracts';
import type { Express } from 'express';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { buildContainer, createApp, type Container } from '../../src/composition/container.js';
import { parseEnv } from '../../src/infrastructure/config/env.js';
import { disconnectTestPrisma, testPrisma } from '../integration/setup/db.js';

/**
 * `GET /api/currencies`, `POST /api/currencies` and `PATCH /api/currencies/:code` (plan §4.3.2,
 * §4.3.3), over the test database with fake integrations. The plan fixes the routes, the bodies
 * (`CreateCurrencyInput`, `UpdateCurrencyInput`), the item shape (`CurrencyDto`), the
 * `custom_rate` events and the error codes; it does not fix the success status nor the envelope
 * of the list, so a success is any 2xx answer and the list is either an array of `CurrencyDto`
 * or an object that carries that array.
 */
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
  RELEASE: '1.0',
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

interface CurrencyRow {
  code: string;
  symbol: string;
  isSystem: boolean;
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

const postCurrency = (body: object, cookie: string | null) => {
  const req = request(app).post('/api/currencies').set('Origin', WEB_ORIGIN);
  if (cookie !== null) req.set('Cookie', cookie);
  return req.send(body);
};

const patchCurrency = (code: string, body: object, cookie: string | null) => {
  const req = request(app).patch(`/api/currencies/${code}`).set('Origin', WEB_ORIGIN);
  if (cookie !== null) req.set('Cookie', cookie);
  return req.send(body);
};

const getCurrencies = (cookie: string | null) => {
  const req = request(app).get('/api/currencies');
  if (cookie !== null) req.set('Cookie', cookie);
  return req;
};

const expectSuccess = (res: { status: number }) => {
  expect(res.status).toBeGreaterThanOrEqual(200);
  expect(res.status).toBeLessThan(300);
};

/** The list items of `GET /api/currencies`, whether the body is the array or wraps it. */
const listOf = (body: unknown): unknown[] => {
  if (Array.isArray(body)) return body as unknown[];
  if (typeof body === 'object' && body !== null) {
    const arrays = Object.values(body as Record<string, unknown>).filter(Array.isArray);
    if (arrays.length === 1) return arrays[0] as unknown[];
  }
  throw new Error('the body of GET /api/currencies carries no list');
};

const codeOf = (item: unknown): string | undefined =>
  typeof item === 'object' && item !== null
    ? ((item as { code?: unknown }).code as string | undefined)
    : undefined;

/** The listed currency with that code, checked against `CurrencyDto`. */
async function listed(cookie: string, code: string): Promise<CurrencyDto | undefined> {
  const res = await getCurrencies(cookie);
  expect(res.status).toBe(200);
  const item = listOf(res.body).find((i) => codeOf(i) === code);
  if (item === undefined) return undefined;
  const parsed = CurrencyDto.safeParse(item);
  expect(parsed.success).toBe(true);
  return parsed.data;
}

async function currenciesOf(userId: string): Promise<CurrencyRow[]> {
  return db.$queryRaw<CurrencyRow[]>`
    SELECT code::text AS code, symbol, is_system AS "isSystem", status::text AS status
      FROM currency WHERE user_id = ${userId}::uuid ORDER BY code`;
}

async function rateEventsOf(userId: string, code: string): Promise<RateEventRow[]> {
  return db.$queryRaw<RateEventRow[]>`
    SELECT currency_code::text AS "currencyCode", value::text AS value
      FROM user_fx_event
     WHERE user_id = ${userId}::uuid AND kind = 'custom_rate' AND currency_code = ${code}
     ORDER BY effective_at, id`;
}

async function allRateEventsOf(userId: string): Promise<RateEventRow[]> {
  return db.$queryRaw<RateEventRow[]>`
    SELECT currency_code::text AS "currencyCode", value::text AS value
      FROM user_fx_event
     WHERE user_id = ${userId}::uuid AND kind = 'custom_rate'
     ORDER BY effective_at, id`;
}

beforeAll(async () => {
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

describe('POST /api/currencies', () => {
  it('TASK-088 sin sesión responde 401', async () => {
    expect((await postCurrency({ code: 'EUR', symbol: '€', rate: '7.50' }, null)).status).toBe(
      401,
    );
  });

  it('RF-M3-02 crea la moneda activa y su custom_rate con la tasa en bolivianos', async () => {
    const { cookie, userId } = await signedIn();

    const res = await postCurrency({ code: 'EUR', symbol: '€', rate: '7.50' }, cookie);

    expectSuccess(res);
    const eur = (await currenciesOf(userId)).find((c) => c.code === 'EUR');
    expect(eur).toEqual({ code: 'EUR', symbol: '€', isSystem: false, status: 'active' });
    expect(await rateEventsOf(userId, 'EUR')).toEqual([{ currencyCode: 'EUR', value: '7.50' }]);
  });

  it('RF-M3-02 un código repetido responde 409 CURRENCY_CODE_TAKEN y no agrega otra tasa', async () => {
    const { cookie, userId } = await signedIn();
    expectSuccess(await postCurrency({ code: 'EUR', symbol: '€', rate: '7.50' }, cookie));

    const res = await postCurrency({ code: 'EUR', symbol: 'E', rate: '8.00' }, cookie);

    expect(res.status).toBe(409);
    expect(problem(res).code).toBe('CURRENCY_CODE_TAKEN');
    expect((await currenciesOf(userId)).filter((c) => c.code === 'EUR')).toEqual([
      { code: 'EUR', symbol: '€', isSystem: false, status: 'active' },
    ]);
    expect(await rateEventsOf(userId, 'EUR')).toEqual([{ currencyCode: 'EUR', value: '7.50' }]);
  });

  it('RF-M3-02 el código de BOB o USD, que el usuario ya tiene, responde 409 CURRENCY_CODE_TAKEN', async () => {
    const { cookie, userId } = await signedIn();

    const usd = await postCurrency({ code: 'USD', symbol: '$', rate: '10.00' }, cookie);
    const bob = await postCurrency({ code: 'BOB', symbol: 'Bs', rate: '1.00' }, cookie);

    expect(usd.status).toBe(409);
    expect(problem(usd).code).toBe('CURRENCY_CODE_TAKEN');
    expect(bob.status).toBe(409);
    expect(problem(bob).code).toBe('CURRENCY_CODE_TAKEN');
    expect(await allRateEventsOf(userId)).toEqual([]);
  });

  it('RF-M3-02 dos POST simultáneos con el mismo código dejan una sola moneda', async () => {
    const { cookie, userId } = await signedIn();

    const results = await Promise.all([
      postCurrency({ code: 'EUR', symbol: '€', rate: '7.50' }, cookie),
      postCurrency({ code: 'EUR', symbol: '€', rate: '7.60' }, cookie),
    ]);

    const statuses = results.map((r) => r.status).sort((a, b) => a - b);
    expect(statuses[0]).toBeGreaterThanOrEqual(200);
    expect(statuses[0]).toBeLessThan(300);
    expect(statuses[1]).toBe(409);
    expect(results.map((r) => problem(r).code)).toContain('CURRENCY_CODE_TAKEN');
    expect((await currenciesOf(userId)).filter((c) => c.code === 'EUR')).toHaveLength(1);
    expect(await rateEventsOf(userId, 'EUR')).toHaveLength(1);
  });

  it('RF-M3-02 un código que no tiene 3 letras mayúsculas responde 400 VALIDATION_ERROR', async () => {
    const { cookie, userId } = await signedIn();
    const before = await currenciesOf(userId);

    for (const code of ['EU', 'EURO', 'eur', 'E1R']) {
      const res = await postCurrency({ code, symbol: '€', rate: '7.50' }, cookie);
      expect(res.status).toBe(400);
      expect(problem(res).code).toBe('VALIDATION_ERROR');
    }

    expect(await currenciesOf(userId)).toEqual(before);
    expect(await allRateEventsOf(userId)).toEqual([]);
  });

  it('RF-M3-02 una moneda agregada sin tasa responde 400 VALIDATION_ERROR', async () => {
    const { cookie, userId } = await signedIn();

    const res = await postCurrency({ code: 'EUR', symbol: '€' }, cookie);

    expect(res.status).toBe(400);
    expect(problem(res).code).toBe('VALIDATION_ERROR');
    expect((await currenciesOf(userId)).map((c) => c.code)).not.toContain('EUR');
  });

  it('EC-M3-07 una tasa menor que Bs 0,01 responde 422 RATE_BELOW_MINIMUM y no crea la moneda', async () => {
    const { cookie, userId } = await signedIn();

    for (const rate of ['0.00', '0']) {
      const res = await postCurrency({ code: 'ARS', symbol: '$', rate }, cookie);
      expect(res.status).toBe(422);
      expect(problem(res).code).toBe('RATE_BELOW_MINIMUM');
    }

    expect((await currenciesOf(userId)).map((c) => c.code)).not.toContain('ARS');
    expect(await rateEventsOf(userId, 'ARS')).toEqual([]);
  });

  it('EC-M3-07 una tasa de exactamente Bs 0,01 se admite', async () => {
    const { cookie, userId } = await signedIn();

    expectSuccess(await postCurrency({ code: 'CLP', symbol: '$', rate: '0.01' }, cookie));

    expect(await rateEventsOf(userId, 'CLP')).toEqual([{ currencyCode: 'CLP', value: '0.01' }]);
  });

  it('RF-M3-01 una tasa con más de 2 decimales o que no es un número responde 400 VALIDATION_ERROR', async () => {
    const { cookie, userId } = await signedIn();

    for (const rate of ['7.505', 'abc', '7,50']) {
      const res = await postCurrency({ code: 'EUR', symbol: '€', rate }, cookie);
      expect(res.status).toBe(400);
      expect(problem(res).code).toBe('VALIDATION_ERROR');
    }

    expect((await currenciesOf(userId)).map((c) => c.code)).not.toContain('EUR');
  });

  it('TASK-088 la moneda de un usuario no impide que otro agregue el mismo código', async () => {
    const owner = await signedIn();
    const other = await signedIn();
    expectSuccess(await postCurrency({ code: 'EUR', symbol: '€', rate: '7.50' }, owner.cookie));

    expectSuccess(await postCurrency({ code: 'EUR', symbol: 'E', rate: '7.90' }, other.cookie));

    expect(await rateEventsOf(owner.userId, 'EUR')).toEqual([
      { currencyCode: 'EUR', value: '7.50' },
    ]);
    expect(await rateEventsOf(other.userId, 'EUR')).toEqual([
      { currencyCode: 'EUR', value: '7.90' },
    ]);
  });
});

describe('GET /api/currencies', () => {
  it('TASK-088 sin sesión responde 401', async () => {
    expect((await getCurrencies(null)).status).toBe(401);
  });

  it('TASK-088 lista la moneda agregada con su símbolo y su tasa vigente', async () => {
    const { cookie } = await signedIn();
    expectSuccess(await postCurrency({ code: 'EUR', symbol: '€', rate: '7.50' }, cookie));

    expect(await listed(cookie, 'EUR')).toEqual({ code: 'EUR', symbol: '€', rate: '7.50' });
  });

  it('RF-M3-13 después de un cambio de tasa la lista muestra la última', async () => {
    const { cookie } = await signedIn();
    expectSuccess(await postCurrency({ code: 'EUR', symbol: '€', rate: '7.50' }, cookie));
    expectSuccess(await patchCurrency('EUR', { rate: '7.80' }, cookie));

    expect((await listed(cookie, 'EUR'))?.rate).toBe('7.80');
  });

  it('TASK-088 un usuario no ve las monedas agregadas de otro', async () => {
    const owner = await signedIn();
    const other = await signedIn();
    expectSuccess(await postCurrency({ code: 'GBP', symbol: '£', rate: '9.10' }, owner.cookie));

    expect(await listed(other.cookie, 'GBP')).toBeUndefined();
    expect(await listed(owner.cookie, 'GBP')).toEqual({ code: 'GBP', symbol: '£', rate: '9.10' });
  });
});

describe('PATCH /api/currencies/:code', () => {
  it('TASK-088 sin sesión responde 401', async () => {
    expect((await patchCurrency('EUR', { rate: '7.80' }, null)).status).toBe(401);
  });

  it('RF-M3-13 cambiar la tasa inserta un custom_rate y conserva los anteriores', async () => {
    const { cookie, userId } = await signedIn();
    expectSuccess(await postCurrency({ code: 'EUR', symbol: '€', rate: '7.50' }, cookie));

    expectSuccess(await patchCurrency('EUR', { rate: '7.80' }, cookie));

    expect(await rateEventsOf(userId, 'EUR')).toEqual([
      { currencyCode: 'EUR', value: '7.50' },
      { currencyCode: 'EUR', value: '7.80' },
    ]);
  });

  it('RF-M3-13 cada cambio de tasa queda en el historial en orden', async () => {
    const { cookie, userId } = await signedIn();
    expectSuccess(await postCurrency({ code: 'EUR', symbol: '€', rate: '7.50' }, cookie));

    expectSuccess(await patchCurrency('EUR', { rate: '7.80' }, cookie));
    expectSuccess(await patchCurrency('EUR', { rate: '7.65' }, cookie));
    expectSuccess(await patchCurrency('EUR', { rate: '8.00' }, cookie));

    expect((await rateEventsOf(userId, 'EUR')).map((e) => e.value)).toEqual([
      '7.50',
      '7.80',
      '7.65',
      '8.00',
    ]);
  });

  it('TASK-088 cambiar solo el símbolo lo guarda y no inserta custom_rate', async () => {
    const { cookie, userId } = await signedIn();
    expectSuccess(await postCurrency({ code: 'EUR', symbol: 'E', rate: '7.50' }, cookie));

    expectSuccess(await patchCurrency('EUR', { symbol: '€' }, cookie));

    expect((await currenciesOf(userId)).find((c) => c.code === 'EUR')?.symbol).toBe('€');
    expect(await rateEventsOf(userId, 'EUR')).toHaveLength(1);
    expect(await listed(cookie, 'EUR')).toEqual({ code: 'EUR', symbol: '€', rate: '7.50' });
  });

  it('RF-M3-01 cambiar la tasa de USD responde 422 SYSTEM_CURRENCY y no inserta custom_rate', async () => {
    const { cookie, userId } = await signedIn();

    const res = await patchCurrency('USD', { rate: '12.00' }, cookie);

    expect(res.status).toBe(422);
    expect(problem(res).code).toBe('SYSTEM_CURRENCY');
    expect(await allRateEventsOf(userId)).toEqual([]);
  });

  it('RF-M3-01 cambiar la tasa de BOB responde 422 SYSTEM_CURRENCY y no inserta custom_rate', async () => {
    const { cookie, userId } = await signedIn();

    const res = await patchCurrency('BOB', { rate: '1.00' }, cookie);

    expect(res.status).toBe(422);
    expect(problem(res).code).toBe('SYSTEM_CURRENCY');
    expect(await allRateEventsOf(userId)).toEqual([]);
  });

  it('EC-M3-07 una tasa nueva menor que Bs 0,01 se rechaza y conserva la tasa vigente', async () => {
    const { cookie, userId } = await signedIn();
    expectSuccess(await postCurrency({ code: 'EUR', symbol: '€', rate: '7.50' }, cookie));

    const res = await patchCurrency('EUR', { rate: '0.00' }, cookie);

    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.status).toBeLessThan(500);
    expect(await rateEventsOf(userId, 'EUR')).toEqual([{ currencyCode: 'EUR', value: '7.50' }]);
    expect((await listed(cookie, 'EUR'))?.rate).toBe('7.50');
  });

  it('TASK-088 una moneda que el usuario no tiene responde 404 NOT_FOUND', async () => {
    const { cookie, userId } = await signedIn();

    const res = await patchCurrency('JPY', { rate: '0.07' }, cookie);

    expect(res.status).toBe(404);
    expect(problem(res).code).toBe('NOT_FOUND');
    expect(await allRateEventsOf(userId)).toEqual([]);
  });

  it('TASK-088 un usuario no puede cambiar la moneda agregada de otro', async () => {
    const owner = await signedIn();
    const other = await signedIn();
    expectSuccess(await postCurrency({ code: 'EUR', symbol: '€', rate: '7.50' }, owner.cookie));

    const res = await patchCurrency('EUR', { rate: '9.99', symbol: 'X' }, other.cookie);

    expect(res.status).toBe(404);
    expect(problem(res).code).toBe('NOT_FOUND');
    expect(await rateEventsOf(owner.userId, 'EUR')).toEqual([
      { currencyCode: 'EUR', value: '7.50' },
    ]);
    expect((await currenciesOf(owner.userId)).find((c) => c.code === 'EUR')?.symbol).toBe('€');
    expect(await allRateEventsOf(other.userId)).toEqual([]);
  });
});
