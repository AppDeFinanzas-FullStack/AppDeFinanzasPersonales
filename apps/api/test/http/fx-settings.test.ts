import { randomUUID } from 'node:crypto';

import { RatesCurrentDto } from '@finanzas/contracts';
import type { Express } from 'express';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { buildContainer, createApp, type Container } from '../../src/composition/container.js';
import { parseEnv } from '../../src/infrastructure/config/env.js';
import { disconnectTestPrisma, testPrisma } from '../integration/setup/db.js';

/**
 * `PATCH /api/fx-settings`, `PUT /api/fx/manual` and `DELETE /api/fx/manual` (plan §4.3.2,
 * §4.3.3), over the test database with fake integrations. The plan fixes the routes, the bodies
 * (`FxSettingsInput`, `ManualUsdInput`), the `user_fx_event` kinds and `CURRENCY_INACTIVE 422`;
 * it does not fix the success body, so a success is any 2xx answer.
 */
const WEB_ORIGIN = 'http://localhost:5173';
const COOKIE_NAME = '__Secure-better-auth.session_token';
const DAY = 24 * 60 * 60_000;

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

interface SettingsRow {
  baseCurrency: string;
  usdReference: string;
  manualUsdValue: string | null;
  manualUsdSince: Date | null;
}

interface EventRow {
  kind: string;
  currencyCode: string | null;
  reference: string | null;
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

const patchFxSettings = (body: object, cookie: string | null) => {
  const req = request(app).patch('/api/fx-settings').set('Origin', WEB_ORIGIN);
  if (cookie !== null) req.set('Cookie', cookie);
  return req.send(body);
};

const putManual = (body: object, cookie: string | null) => {
  const req = request(app).put('/api/fx/manual').set('Origin', WEB_ORIGIN);
  if (cookie !== null) req.set('Cookie', cookie);
  return req.send(body);
};

const deleteManual = (cookie: string | null) => {
  const req = request(app).delete('/api/fx/manual').set('Origin', WEB_ORIGIN);
  if (cookie !== null) req.set('Cookie', cookie);
  return req;
};

const expectSuccess = (res: { status: number }) => {
  expect(res.status).toBeGreaterThanOrEqual(200);
  expect(res.status).toBeLessThan(300);
};

async function settingsOf(userId: string): Promise<SettingsRow> {
  const rows = await db.$queryRaw<SettingsRow[]>`
    SELECT base_currency::text AS "baseCurrency", usd_reference::text AS "usdReference",
           manual_usd_value::text AS "manualUsdValue", manual_usd_since AS "manualUsdSince"
      FROM user_settings WHERE user_id = ${userId}::uuid`;
  const row = rows[0];
  if (row === undefined) throw new Error('the user has no user_settings row');
  return row;
}

async function eventsOf(userId: string, kind: string): Promise<EventRow[]> {
  return db.$queryRaw<EventRow[]>`
    SELECT kind::text AS kind, currency_code::text AS "currencyCode",
           reference::text AS reference, value::text AS value
      FROM user_fx_event
     WHERE user_id = ${userId}::uuid AND kind = ${kind}::fx_event_kind
     ORDER BY effective_at, id`;
}

/** Every column of the user's `ledger_transaction` rows, as text, in a fixed order. */
async function ledgerSnapshot(userId: string): Promise<unknown[]> {
  return db.$queryRaw<unknown[]>`
    SELECT row_to_json(t)::text AS row FROM ledger_transaction t
     WHERE user_id = ${userId}::uuid ORDER BY id`;
}

/** Two movements with the rates they were recorded with. */
async function recordedMovements(userId: string): Promise<void> {
  const categories = await db.$queryRaw<{ id: string }[]>`
    SELECT id::text AS id FROM category
     WHERE user_id = ${userId}::uuid AND kind = 'expense' LIMIT 1`;
  const categoryId = categories[0]?.id;
  if (categoryId === undefined) throw new Error('the user has no expense category');
  await db.$executeRaw`
    INSERT INTO ledger_transaction (id, user_id, kind, date, category_id, rate_cur_bob, rate_usd_bob)
    VALUES (${randomUUID()}::uuid, ${userId}::uuid, 'expense', DATE '2026-03-15',
            ${categoryId}::uuid, 1, 10.40),
           (${randomUUID()}::uuid, ${userId}::uuid, 'expense', DATE '2026-04-02',
            ${categoryId}::uuid, 10.55, 10.55)`;
}

/** An added currency with its rate, active or inactive. */
async function addedCurrency(
  userId: string,
  code: string,
  status: 'active' | 'inactive',
): Promise<void> {
  await db.$executeRaw`
    INSERT INTO currency (user_id, code, symbol, is_system, status)
    VALUES (${userId}::uuid, ${code}, ${code}, false, ${status}::currency_status)`;
  await db.$executeRaw`
    INSERT INTO user_fx_event (id, user_id, kind, currency_code, value)
    VALUES (${randomUUID()}::uuid, ${userId}::uuid, 'custom_rate', ${code}, 7.50)`;
}

/** Waits until no refresh holds the `fx_refresh` lease (a `GET /api/rates/current` may start one). */
async function leaseFree(timeoutMs = 8000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const rows = await db.$queryRaw<{ free: boolean }[]>`
      SELECT (locked_until IS NULL OR locked_until < now()) AS free
        FROM job_run WHERE job = 'fx_refresh'`;
    if (rows[0]?.free ?? true) return;
    await sleep(50);
  }
}

beforeAll(async () => {
  container = await Promise.resolve(buildContainer(parseEnv(envSource())));
  app = await Promise.resolve(createApp(container));
}, 30_000);

afterAll(async () => {
  await sleep(300);
  await leaseFree();
  await db.$executeRaw`DELETE FROM auth_user WHERE email = ANY(${usedEmails}::text[])`;
  await db.$executeRaw`DELETE FROM email_outbox WHERE to_address = ANY(${usedEmails}::text[])`;
  await disconnectTestPrisma();
  await container.prisma.$disconnect();
}, 30_000);

describe('PATCH /api/fx-settings', () => {
  it('TASK-087 sin sesión responde 401', async () => {
    expect((await patchFxSettings({ usdReference: 'official' }, null)).status).toBe(401);
  });

  it('RF-M3-13 cambiar la referencia la guarda y deja un reference_set en user_fx_event', async () => {
    const { cookie, userId } = await signedIn();
    const before = await eventsOf(userId, 'reference_set');

    const res = await patchFxSettings({ usdReference: 'official' }, cookie);

    expectSuccess(res);
    expect((await settingsOf(userId)).usdReference).toBe('official');
    const after = await eventsOf(userId, 'reference_set');
    expect(after).toHaveLength(before.length + 1);
    expect(after.at(-1)).toMatchObject({ reference: 'official', value: null });
  });

  it('RF-M3-13 cada cambio de referencia queda como un evento propio', async () => {
    const { cookie, userId } = await signedIn();
    const before = await eventsOf(userId, 'reference_set');

    expectSuccess(await patchFxSettings({ usdReference: 'parallel_ask' }, cookie));
    expectSuccess(await patchFxSettings({ usdReference: 'parallel_bid' }, cookie));
    expectSuccess(await patchFxSettings({ usdReference: 'official' }, cookie));

    const after = await eventsOf(userId, 'reference_set');
    expect(after.slice(before.length).map((e) => e.reference)).toEqual([
      'parallel_ask',
      'parallel_bid',
      'official',
    ]);
    expect((await settingsOf(userId)).usdReference).toBe('official');
  });

  it('TASK-087 repetir la referencia vigente no inserta otro reference_set', async () => {
    const { cookie, userId } = await signedIn();
    expectSuccess(await patchFxSettings({ usdReference: 'official' }, cookie));
    const before = await eventsOf(userId, 'reference_set');

    expectSuccess(await patchFxSettings({ usdReference: 'official' }, cookie));

    expect(await eventsOf(userId, 'reference_set')).toHaveLength(before.length);
  });

  it('TASK-087 cambiar la moneda base a una moneda activa la guarda', async () => {
    const { cookie, userId } = await signedIn();

    expectSuccess(await patchFxSettings({ baseCurrency: 'USD' }, cookie));
    expect((await settingsOf(userId)).baseCurrency).toBe('USD');

    await addedCurrency(userId, 'EUR', 'active');
    expectSuccess(await patchFxSettings({ baseCurrency: 'EUR' }, cookie));
    expect((await settingsOf(userId)).baseCurrency).toBe('EUR');
  });

  it('TASK-087 una base inactiva responde 422 CURRENCY_INACTIVE y no cambia la base', async () => {
    const { cookie, userId } = await signedIn();
    await addedCurrency(userId, 'EUR', 'inactive');
    const before = await settingsOf(userId);

    const res = await patchFxSettings({ baseCurrency: 'EUR' }, cookie);

    expect(res.status).toBe(422);
    expect(problem(res).code).toBe('CURRENCY_INACTIVE');
    expect((await settingsOf(userId)).baseCurrency).toBe(before.baseCurrency);
  });

  it('TASK-087 una referencia fuera de UsdReference responde 400 VALIDATION_ERROR', async () => {
    const { cookie, userId } = await signedIn();
    const before = await settingsOf(userId);

    const res = await patchFxSettings({ usdReference: 'manual' }, cookie);

    expect(res.status).toBe(400);
    expect(problem(res).code).toBe('VALIDATION_ERROR');
    expect((await settingsOf(userId)).usdReference).toBe(before.usdReference);
  });

  it('RF-M3-11 cambiar la referencia no modifica ninguna fila de ledger_transaction', async () => {
    const { cookie, userId } = await signedIn();
    await recordedMovements(userId);
    const before = await ledgerSnapshot(userId);
    expect(before).toHaveLength(2);

    expectSuccess(await patchFxSettings({ usdReference: 'official' }, cookie));
    expectSuccess(await patchFxSettings({ usdReference: 'parallel_bid' }, cookie));

    expect(await ledgerSnapshot(userId)).toEqual(before);
  });

  it('RF-M3-11 cambiar la moneda base no modifica ninguna fila de ledger_transaction', async () => {
    const { cookie, userId } = await signedIn();
    await recordedMovements(userId);
    const before = await ledgerSnapshot(userId);
    expect(before).toHaveLength(2);

    expectSuccess(await patchFxSettings({ baseCurrency: 'USD' }, cookie));
    expectSuccess(await patchFxSettings({ baseCurrency: 'BOB', usdReference: 'official' }, cookie));

    expect(await ledgerSnapshot(userId)).toEqual(before);
  });

  it('TASK-087 el cambio de un usuario no toca la configuración de otro', async () => {
    const owner = await signedIn();
    const other = await signedIn();
    const otherBefore = await settingsOf(other.userId);
    const otherEvents = await eventsOf(other.userId, 'reference_set');

    expectSuccess(
      await patchFxSettings({ usdReference: 'official', baseCurrency: 'USD' }, owner.cookie),
    );

    expect(await settingsOf(other.userId)).toEqual(otherBefore);
    expect(await eventsOf(other.userId, 'reference_set')).toHaveLength(otherEvents.length);
  });
});

describe('PUT y DELETE /api/fx/manual', () => {
  it('TASK-087 sin sesión responden 401', async () => {
    expect((await putManual({ value: '12.50' }, null)).status).toBe(401);
    expect((await deleteManual(null)).status).toBe(401);
  });

  it('TASK-087 PUT activa el valor manual e inserta manual_usd_on', async () => {
    const { cookie, userId } = await signedIn();

    const res = await putManual({ value: '12.50' }, cookie);

    expectSuccess(res);
    const settings = await settingsOf(userId);
    expect(settings.manualUsdValue).toBe('12.50');
    expect(settings.manualUsdSince).not.toBeNull();
    const events = await eventsOf(userId, 'manual_usd_on');
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ currencyCode: 'USD', value: '12.50' });
  });

  it('TASK-087 un valor manual inválido responde 400 VALIDATION_ERROR y no cambia nada', async () => {
    const { cookie, userId } = await signedIn();

    const res = await putManual({ value: '0' }, cookie);

    expect(res.status).toBe(400);
    expect(problem(res).code).toBe('VALIDATION_ERROR');
    expect((await settingsOf(userId)).manualUsdValue).toBeNull();
    expect(await eventsOf(userId, 'manual_usd_on')).toHaveLength(0);
  });

  it('TASK-087 DELETE desactiva el valor manual e inserta manual_usd_off', async () => {
    const { cookie, userId } = await signedIn();
    expectSuccess(await putManual({ value: '12.50' }, cookie));

    const res = await deleteManual(cookie);

    expectSuccess(res);
    expect((await settingsOf(userId)).manualUsdValue).toBeNull();
    const events = await eventsOf(userId, 'manual_usd_off');
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ currencyCode: 'USD', value: null });
    // The history keeps the activation (nothing is rewritten).
    expect(await eventsOf(userId, 'manual_usd_on')).toHaveLength(1);
  });

  it('RF-M3-03 el valor manual activo no vence solo', async () => {
    const { cookie, userId } = await signedIn();
    expectSuccess(await putManual({ value: '12.50' }, cookie));
    // Sixty days go by without the user touching it.
    const longAgo = new Date(Date.now() - 60 * DAY);
    await db.$executeRaw`
      UPDATE user_settings SET manual_usd_since = ${longAgo} WHERE user_id = ${userId}::uuid`;
    await db.$executeRaw`
      UPDATE user_fx_event SET effective_at = ${longAgo}
       WHERE user_id = ${userId}::uuid AND kind = 'manual_usd_on'`;

    const res = await request(app).get('/api/rates/current').set('Cookie', cookie);

    expect(res.status).toBe(200);
    expect(RatesCurrentDto.safeParse(res.body).success).toBe(true);
    const body = res.body as RatesCurrentDto;
    expect(body.inUse.kind).toBe('manual');
    expect(body.inUse.value).toBe('12.50');
    expect((await settingsOf(userId)).manualUsdValue).toBe('12.50');
    expect(await eventsOf(userId, 'manual_usd_off')).toHaveLength(0);
  });

  it('RF-M3-03 el valor manual activo tiene prioridad sobre la referencia elegida', async () => {
    const { cookie } = await signedIn();
    expectSuccess(await patchFxSettings({ usdReference: 'official' }, cookie));
    expectSuccess(await putManual({ value: '12.50' }, cookie));

    const on = await request(app).get('/api/rates/current').set('Cookie', cookie);
    expect(on.status).toBe(200);
    expect((on.body as RatesCurrentDto).inUse).toMatchObject({ kind: 'manual', value: '12.50' });

    expectSuccess(await deleteManual(cookie));
    const off = await request(app).get('/api/rates/current').set('Cookie', cookie);
    expect(off.status).toBe(200);
    expect((off.body as RatesCurrentDto).inUse.kind).toBe('official');
  });

  it('RF-M3-11 activar y desactivar el valor manual no modifica ninguna fila de ledger_transaction', async () => {
    const { cookie, userId } = await signedIn();
    await recordedMovements(userId);
    const before = await ledgerSnapshot(userId);

    expectSuccess(await putManual({ value: '12.50' }, cookie));
    expectSuccess(await deleteManual(cookie));

    expect(await ledgerSnapshot(userId)).toEqual(before);
  });

  it('TASK-087 el valor manual de un usuario no toca la configuración de otro', async () => {
    const owner = await signedIn();
    const other = await signedIn();

    expectSuccess(await putManual({ value: '12.50' }, owner.cookie));

    expect((await settingsOf(other.userId)).manualUsdValue).toBeNull();
    expect(await eventsOf(other.userId, 'manual_usd_on')).toHaveLength(0);
  });
});
