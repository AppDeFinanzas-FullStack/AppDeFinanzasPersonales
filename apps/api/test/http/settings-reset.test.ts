import { randomUUID } from 'node:crypto';

import { DEFAULT_DASHBOARD_BLOCKS, type SettingsDto } from '@finanzas/contracts';
import type { Express } from 'express';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { buildContainer, createApp, type Container } from '../../src/composition/container.js';
import { parseEnv } from '../../src/infrastructure/config/env.js';
import { createAccount } from '../factories/account.factory.js';
import {
  createCategory,
  createCategoryShortcut,
  deleteCategoryUsageOf,
} from '../factories/category.factory.js';
import { createLedgerTransaction, deleteLedgerOf } from '../factories/ledger.factory.js';
import { disconnectTestPrisma, testPrisma } from '../integration/setup/db.js';

/**
 * `POST /api/settings/reset` with `ResetSettingsInput` (plan §4.9.1, §4.9.2): each section goes
 * back to its defaults and no data changes (RF-M9-05). The plan does not fix the success body, so
 * a success is any 2xx answer and the settings are read back through `GET /api/settings` and the
 * `user_settings` row. Over the test database with fake integrations, as in `fx-settings.test.ts`.
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

type Section = 'general' | 'currencies' | 'register' | 'dashboard' | 'reminders';

interface Problem {
  code?: string;
  status?: number;
}
const problem = (res: { body: unknown }) => res.body as Problem;

interface Account {
  cookie: string;
  userId: string;
}

interface FxRow {
  baseCurrency: string;
  usdReference: string;
  manualUsdValue: string | null;
  manualUsdSince: Date | null;
}

interface EventRow {
  kind: string;
  currencyCode: string | null;
  value: string | null;
}

const db = testPrisma();
let container: Container;
let app: Express;
const usedEmails: string[] = [];
const usedUserIds: string[] = [];

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
  usedUserIds.push(userId);
  return { cookie: sessionCookieOf(res), userId };
}

const send = (method: 'post' | 'patch' | 'put', path: string, body: object, cookie?: string) => {
  const req = request(app)[method](path).set('Origin', WEB_ORIGIN);
  if (cookie !== undefined) req.set('Cookie', cookie);
  return req.send(body);
};

const reset = (body: object, cookie?: string) => send('post', '/api/settings/reset', body, cookie);

const expectSuccess = (res: { status: number }) => {
  expect(res.status).toBeGreaterThanOrEqual(200);
  expect(res.status).toBeLessThan(300);
};

const readSettings = async (cookie: string): Promise<SettingsDto> => {
  const res = await request(app).get('/api/settings').set('Cookie', cookie);
  expect(res.status).toBe(200);
  return res.body as SettingsDto;
};

async function fxOf(userId: string): Promise<FxRow> {
  const rows = await db.$queryRaw<FxRow[]>`
    SELECT base_currency::text AS "baseCurrency", usd_reference::text AS "usdReference",
           manual_usd_value::text AS "manualUsdValue", manual_usd_since AS "manualUsdSince"
      FROM user_settings WHERE user_id = ${userId}::uuid`;
  const row = rows[0];
  if (row === undefined) throw new Error('the user has no user_settings row');
  return row;
}

async function eventsOf(userId: string, kind: string): Promise<EventRow[]> {
  return db.$queryRaw<EventRow[]>`
    SELECT kind::text AS kind, currency_code::text AS "currencyCode", value::text AS value
      FROM user_fx_event
     WHERE user_id = ${userId}::uuid AND kind = ${kind}::fx_event_kind
     ORDER BY effective_at, id`;
}

/**
 * Every row of the user's data as JSON text: accounts, movements (transactions and entries),
 * categories, shortcuts, currencies and the base currency (RF-M9-05).
 */
async function dataSnapshot(userId: string): Promise<Record<string, unknown>> {
  const rowsOf = (table: string, order: string) =>
    db.$queryRawUnsafe<{ row: string }[]>(
      `SELECT row_to_json(t)::text AS row FROM ${table} t
        WHERE user_id = $1::uuid ORDER BY ${order}`,
      userId,
    );
  return {
    accounts: await rowsOf('account', 'id'),
    transactions: await rowsOf('ledger_transaction', 'id'),
    entries: await rowsOf('ledger_entry', 'id'),
    categories: await rowsOf('category', 'id'),
    shortcuts: await rowsOf('shortcut', 'id'),
    currencies: await rowsOf('currency', 'code'),
    baseCurrency: (await fxOf(userId)).baseCurrency,
  };
}

/**
 * A user with data of every kind (an account, a category, a movement, a shortcut, an added
 * currency and a base currency other than the default) and every setting customized.
 */
async function customizedUserWithData(): Promise<Account> {
  const account = await signedIn();
  const { cookie, userId } = account;
  const cash = await createAccount(userId);
  const food = await createCategory(userId, { kind: 'expense' });
  const salary = await createCategory(userId, { kind: 'income' });
  await createLedgerTransaction(userId, {
    kind: 'expense',
    date: '2026-03-15',
    categoryId: food.id,
    entries: [{ accountId: cash.id, amount: '-25.50' }],
  });
  await createCategoryShortcut(userId, food.id, cash.id);
  await db.$executeRaw`
    INSERT INTO currency (user_id, code, symbol, is_system, status)
    VALUES (${userId}::uuid, 'EUR', 'EUR', false, 'active'::currency_status)`;
  await db.$executeRaw`
    INSERT INTO user_fx_event (id, user_id, kind, currency_code, value)
    VALUES (${randomUUID()}::uuid, ${userId}::uuid, 'custom_rate', 'EUR', 7.50)`;

  expectSuccess(await send('patch', '/api/fx-settings', { baseCurrency: 'USD' }, cookie));
  expectSuccess(await send('patch', '/api/fx-settings', { usdReference: 'official' }, cookie));
  expectSuccess(await send('put', '/api/fx/manual', { value: '12.50' }, cookie));
  expectSuccess(
    await send(
      'patch',
      '/api/settings',
      {
        numberFormat: 'comma_dot',
        dateFormat: 'iso',
        weekStart: 'sunday',
        theme: 'dark',
        defaultAccountId: cash.id,
        alwaysShowNote: true,
        dashboardBlocks: [...DEFAULT_DASHBOARD_BLOCKS]
          .reverse()
          .map((block) => ({ ...block, visible: block.key !== 'pace' })),
      },
      cookie,
    ),
  );
  expectSuccess(
    await send(
      'patch',
      '/api/settings',
      { favoriteCategories: { kind: 'expense', ids: [food.id] } },
      cookie,
    ),
  );
  expectSuccess(
    await send(
      'patch',
      '/api/settings',
      { favoriteCategories: { kind: 'income', ids: [salary.id] } },
      cookie,
    ),
  );
  return account;
}

async function expectDataUnchangedAfter(section: Section): Promise<void> {
  const { cookie, userId } = await customizedUserWithData();
  const before = await dataSnapshot(userId);
  expect(before['baseCurrency']).toBe('USD');

  expectSuccess(await reset({ section }, cookie));

  expect(await dataSnapshot(userId)).toEqual(before);
}

beforeAll(async () => {
  container = await Promise.resolve(buildContainer(parseEnv(envSource())));
  app = await Promise.resolve(createApp(container));
}, 30_000);

afterAll(async () => {
  await deleteLedgerOf(usedUserIds);
  await deleteCategoryUsageOf(usedUserIds);
  await db.$executeRaw`DELETE FROM auth_user WHERE email = ANY(${usedEmails}::text[])`;
  await db.$executeRaw`DELETE FROM email_outbox WHERE to_address = ANY(${usedEmails}::text[])`;
  await disconnectTestPrisma();
  await container.prisma.$disconnect();
}, 30_000);

describe('POST /api/settings/reset: entrada', () => {
  it('TASK-150 sin sesión responde 401', async () => {
    expect((await reset({ section: 'general' })).status).toBe(401);
  });

  it('TASK-150 una sección desconocida responde 400 VALIDATION_ERROR', async () => {
    const { cookie } = await signedIn();

    const res = await reset({ section: 'everything' }, cookie);

    expect(res.status).toBe(400);
    expect(problem(res).code).toBe('VALIDATION_ERROR');
  });
});

describe('POST /api/settings/reset: valores por defecto de cada sección', () => {
  it('TASK-150 general vuelve los formatos, la semana y el tema por defecto', async () => {
    const { cookie } = await customizedUserWithData();
    const before = await readSettings(cookie);

    expectSuccess(await reset({ section: 'general' }, cookie));

    const after = await readSettings(cookie);
    expect(after).toMatchObject({
      numberFormat: 'dot_comma',
      dateFormat: 'dmy',
      weekStart: 'monday',
      theme: 'system',
    });
    // The other sections keep their values.
    expect(after.defaultAccountId).toBe(before.defaultAccountId);
    expect(after.alwaysShowNote).toBe(true);
    expect(after.favorites).toEqual(before.favorites);
    expect(after.dashboardBlocks).toEqual(before.dashboardBlocks);
  });

  it('RF-M9-05 currencies desactiva el valor manual y deja parallel_median', async () => {
    const { cookie, userId } = await signedIn();
    expectSuccess(await send('patch', '/api/fx-settings', { usdReference: 'official' }, cookie));
    expectSuccess(await send('put', '/api/fx/manual', { value: '12.50' }, cookie));
    expect(await eventsOf(userId, 'manual_usd_off')).toHaveLength(0);

    expectSuccess(await reset({ section: 'currencies' }, cookie));

    const fx = await fxOf(userId);
    expect(fx.usdReference).toBe('parallel_median');
    expect(fx.manualUsdValue).toBeNull();
    const off = await eventsOf(userId, 'manual_usd_off');
    expect(off).toHaveLength(1);
    expect(off[0]).toMatchObject({ currencyCode: 'USD', value: null });
    // The history keeps the activation (nothing is rewritten).
    expect(await eventsOf(userId, 'manual_usd_on')).toHaveLength(1);
  });

  it('RF-M9-05 currencies no cambia la moneda base ni los ajustes de las otras secciones', async () => {
    const { cookie, userId } = await customizedUserWithData();
    const before = await readSettings(cookie);

    expectSuccess(await reset({ section: 'currencies' }, cookie));

    const fx = await fxOf(userId);
    expect(fx.baseCurrency).toBe('USD');
    expect(fx.usdReference).toBe('parallel_median');
    expect(fx.manualUsdValue).toBeNull();
    expect(await readSettings(cookie)).toEqual(before);
  });

  it('TASK-150 register deja la cuenta por defecto en NULL, borra las favoritas y apaga la nota', async () => {
    const { cookie, userId } = await customizedUserWithData();
    const before = await readSettings(cookie);
    expect(before.defaultAccountId).not.toBeNull();

    expectSuccess(await reset({ section: 'register' }, cookie));

    const after = await readSettings(cookie);
    expect(after.defaultAccountId).toBeNull();
    expect(after.favorites).toEqual({ expense: [], income: [] });
    expect(after.alwaysShowNote).toBe(false);
    const rows = await db.$queryRaw<{ n: number }[]>`
      SELECT count(*)::int AS n FROM favorite_category WHERE user_id = ${userId}::uuid`;
    expect(rows[0]?.n).toBe(0);
    // The other sections keep their values.
    expect(after.numberFormat).toBe('comma_dot');
    expect(after.dashboardBlocks).toEqual(before.dashboardBlocks);
  });

  it('TASK-150 dashboard restaura los bloques por defecto', async () => {
    const { cookie } = await customizedUserWithData();
    const before = await readSettings(cookie);
    expect(before.dashboardBlocks).not.toEqual(DEFAULT_DASHBOARD_BLOCKS);

    expectSuccess(await reset({ section: 'dashboard' }, cookie));

    const after = await readSettings(cookie);
    expect(after.dashboardBlocks).toEqual(DEFAULT_DASHBOARD_BLOCKS);
    expect(after.theme).toBe('dark');
    expect(after.defaultAccountId).toBe(before.defaultAccountId);
  });

  it('TASK-150 reminders responde con éxito y no cambia los ajustes de las otras secciones', async () => {
    const { cookie } = await customizedUserWithData();
    const before = await readSettings(cookie);

    expectSuccess(await reset({ section: 'reminders' }, cookie));

    expect(await readSettings(cookie)).toEqual(before);
  });

  it('TASK-150 aislamiento: restablecer una sección no toca los ajustes de otro usuario', async () => {
    const owner = await customizedUserWithData();
    const other = await customizedUserWithData();
    const otherSettings = await readSettings(other.cookie);
    const otherFx = await fxOf(other.userId);

    for (const section of ['general', 'currencies', 'register', 'dashboard'] as const) {
      expectSuccess(await reset({ section }, owner.cookie));
    }

    expect(await readSettings(other.cookie)).toEqual(otherSettings);
    expect(await fxOf(other.userId)).toEqual(otherFx);
  });
});

describe('POST /api/settings/reset: nunca toca datos', () => {
  it('RF-M9-05 general no cambia cuentas, movimientos, categorías, atajos, monedas ni moneda base', async () => {
    await expectDataUnchangedAfter('general');
  });

  it('RF-M9-05 currencies no cambia cuentas, movimientos, categorías, atajos, monedas ni moneda base', async () => {
    await expectDataUnchangedAfter('currencies');
  });

  it('RF-M9-05 register no cambia cuentas, movimientos, categorías, atajos, monedas ni moneda base', async () => {
    await expectDataUnchangedAfter('register');
  });

  it('RF-M9-05 dashboard no cambia cuentas, movimientos, categorías, atajos, monedas ni moneda base', async () => {
    await expectDataUnchangedAfter('dashboard');
  });

  it('RF-M9-05 reminders no cambia cuentas, movimientos, categorías, atajos, monedas ni moneda base', async () => {
    await expectDataUnchangedAfter('reminders');
  });
});
