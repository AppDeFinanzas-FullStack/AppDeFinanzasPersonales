import { createHmac, randomUUID } from 'node:crypto';

import { OnboardingDto, type CreateCategoryInput, type Step2Input } from '@finanzas/contracts';
import type { Express } from 'express';
import request from 'supertest';
import { uuidv7 } from 'uuidv7';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { buildContainer, createApp, type Container } from '../../src/composition/container.js';
import { parseEnv } from '../../src/infrastructure/config/env.js';
import { deleteLedgerOf } from '../factories/ledger.factory.js';
import { disconnectTestPrisma, testPrisma } from '../integration/setup/db.js';

/**
 * The routes of the Onboarding (plan §4.10.2): `GET /api/onboarding`, `POST /api/onboarding/step1`,
 * `/step2`, `/step3`, `/skip` and `/skip-all`, with the lifecycle of plan §4.10.3. Accounts are
 * made through `sign-up` and `confirm` over the test database with fake integrations, as in
 * `settings.test.ts`; a new user waits in step 1. The tests put a user in another step, or finish
 * its Onboarding, by SQL on `user_settings`, and read `user_settings`, `account` and `category`
 * back. The plan does not fix the success status nor the body of the `POST`s, so the tests only
 * ask for a 2xx there; `GET` answers 200 with an `OnboardingDto` (plan §4.10.1). Errors are
 * problems (ADR-09): `STEP_MISMATCH` carries `data = { currentStep }`.
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
  data?: Record<string, unknown>;
}

interface HttpResult {
  status: number;
  body: unknown;
}

const problem = (res: HttpResult): Problem => res.body as Problem;

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

// ---------- HTTP helpers ----------

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

interface Account {
  email: string;
  cookie: string;
  userId: string;
}

/** A confirmed user with a session; its Onboarding waits in step 1. */
async function activeAccount(timezone?: string): Promise<Account> {
  const email = `${randomUUID()}@http-onboarding.test`;
  usedEmails.add(email);
  const up = await post('/api/auth/sign-up', {
    name: 'Ana Pérez',
    email,
    password: PASSWORD,
    acceptTerms: true,
    ...(timezone === undefined ? {} : { timezone }),
  });
  expect(up.status).toBe(202);
  const links = await testPrisma().$queryRaw<{ link: string | null }[]>`
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
  const users = await testPrisma().$queryRaw<{ id: string }[]>`
    SELECT id::text AS id FROM auth_user WHERE email = ${email}`;
  const userId = users[0]?.id;
  if (userId === undefined) throw new Error('no user');
  usedUserIds.push(userId);
  return { email, cookie: sessionCookieOf(res), userId };
}

/** A user whose Onboarding waits in `step`, or is already finished. */
async function accountIn(step: 1 | 2 | 3, completed = false): Promise<Account> {
  const account = await activeAccount();
  await setOnboarding(account.userId, step, completed);
  return account;
}

const onboarding = (cookie?: string) => get('/api/onboarding', cookie);
const step1 = (body: object, cookie?: string) => post('/api/onboarding/step1', body, cookie);
const step2 = (body: object, cookie?: string) => post('/api/onboarding/step2', body, cookie);
const step3 = (body: object, cookie?: string) => post('/api/onboarding/step3', body, cookie);
const skip = (body: object, cookie?: string) => post('/api/onboarding/skip', body, cookie);
const skipAll = (cookie?: string) => post('/api/onboarding/skip-all', {}, cookie);

function expectSuccess(res: HttpResult): void {
  expect(res.status, JSON.stringify(res.body)).toBeGreaterThanOrEqual(200);
  expect(res.status, JSON.stringify(res.body)).toBeLessThan(300);
}

function expectProblem(res: HttpResult, status: number, code: string): Problem {
  expect(res.status, JSON.stringify(res.body)).toBe(status);
  const body = problem(res);
  expect(body.code).toBe(code);
  return body;
}

function expectStepMismatch(res: HttpResult, currentStep: number): void {
  const body = expectProblem(res, 409, 'STEP_MISMATCH');
  expect(body.data).toEqual({ currentStep });
}

function onboardingOf(res: HttpResult): OnboardingDto {
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  const parsed = OnboardingDto.safeParse(res.body);
  expect(parsed.success, JSON.stringify(parsed.error?.issues ?? [])).toBe(true);
  if (!parsed.success) throw new Error('the body is not an OnboardingDto');
  return parsed.data;
}

// ---------- Database helpers ----------

interface Progress {
  step: number;
  completed: boolean;
}

async function progressOf(userId: string): Promise<Progress> {
  const rows = await testPrisma().$queryRaw<Progress[]>`
    SELECT onboarding_step::int AS step,
           (onboarding_completed_at IS NOT NULL) AS completed
      FROM user_settings
     WHERE user_id = ${userId}::uuid`;
  const row = rows[0];
  if (!row) throw new Error(`No user_settings for ${userId}`);
  return row;
}

/** Leaves the user's Onboarding in that step, finished or not. */
async function setOnboarding(userId: string, step: 1 | 2 | 3, completed = false): Promise<void> {
  await testPrisma().$executeRaw`
    UPDATE user_settings
       SET onboarding_step = ${step}::smallint,
           onboarding_completed_at = CASE WHEN ${completed}::boolean THEN now() ELSE NULL END
     WHERE user_id = ${userId}::uuid`;
}

async function baseCurrencyOf(userId: string): Promise<string> {
  const rows = await testPrisma().$queryRaw<{ base: string }[]>`
    SELECT btrim(base_currency::text) AS base FROM user_settings WHERE user_id = ${userId}::uuid`;
  const row = rows[0];
  if (!row) throw new Error(`No user_settings for ${userId}`);
  return row.base;
}

async function timezoneOf(userId: string): Promise<string> {
  const rows = await testPrisma().$queryRaw<{ timezone: string }[]>`
    SELECT timezone FROM auth_user WHERE id = ${userId}::uuid`;
  const row = rows[0];
  if (!row) throw new Error(`No user ${userId}`);
  return row.timezone;
}

interface StoredAccount {
  id: string;
  type: string;
  name: string;
  currencyCode: string;
  initialBalance: string;
  initialBalanceDate: string;
  status: string;
}

async function accountsOf(userId: string): Promise<StoredAccount[]> {
  return testPrisma().$queryRaw<StoredAccount[]>`
    SELECT id::text AS id, type::text AS type, name, btrim(currency_code::text) AS "currencyCode",
           initial_balance::text AS "initialBalance",
           initial_balance_date::text AS "initialBalanceDate", status::text AS status
      FROM account
     WHERE user_id = ${userId}::uuid
     ORDER BY id`;
}

type Kind = 'expense' | 'income';

interface StoredCategory {
  id: string;
  kind: Kind;
  parentId: string | null;
  name: string;
  systemKey: string | null;
}

async function categoriesOf(userId: string): Promise<StoredCategory[]> {
  return testPrisma().$queryRaw<StoredCategory[]>`
    SELECT id::text AS id, kind::text AS kind, parent_id::text AS "parentId", name,
           system_key::text AS "systemKey"
      FROM category
     WHERE user_id = ${userId}::uuid
     ORDER BY id`;
}

/** The only category of that kind with that name. */
function named(rows: readonly StoredCategory[], kind: Kind, name: string): StoredCategory {
  const found = rows.filter((row) => row.kind === kind && row.name === name);
  const [row] = found;
  if (found.length !== 1 || !row) {
    throw new Error(`Expected one ${kind} category named "${name}", found ${found.length}`);
  }
  return row;
}

/** The system category "Deudas y préstamos" of that kind (plan §4.5.3). */
function debtsOf(rows: readonly StoredCategory[], kind: Kind): StoredCategory {
  const row = rows.find((category) => category.kind === kind && category.systemKey === 'debts');
  if (!row) throw new Error(`No ${kind} system category debts`);
  return row;
}

const without = (rows: readonly StoredCategory[], ids: readonly string[]): StoredCategory[] =>
  rows.filter((row) => !ids.includes(row.id));

/** The category plus its subcategories. */
const withChildren = (rows: readonly StoredCategory[], parentId: string): string[] =>
  rows.filter((row) => row.id === parentId || row.parentId === parentId).map((row) => row.id);

const byId = (a: { id: string }, b: { id: string }): number =>
  a.id < b.id ? -1 : a.id > b.id ? 1 : 0;

/** Every category id of an `OnboardingDto` tree, the subcategories included. */
const treeIds = (dto: OnboardingDto): string[] =>
  dto.presets.categories.flatMap((node) => [node.id, ...node.children.map((child) => child.id)]);

type Step2Account = Step2Input['accounts'][number];

/** An account of step 2 with a new client id (ADR-11). */
const entry = (
  name: string,
  type: Step2Account['type'],
  balance: string,
  currencyCode = 'BOB',
): Step2Account => ({ id: uuidv7(), name, type, currencyCode, balance });

/** A new category of step 3 with a new client id (ADR-11). */
const newCategory = (kind: Kind, name: string): CreateCategoryInput => ({
  id: uuidv7(),
  kind,
  parentId: null,
  name,
  icon: 'heart-pulse',
});

// ---------- Session ----------

describe('TASK-159 rutas del Onboarding: sesión', () => {
  it('TASK-159 sin sesión, GET y cada POST del Onboarding responden 401', async () => {
    expect((await onboarding()).status).toBe(401);
    expect((await step1({ baseCurrency: 'BOB' })).status).toBe(401);
    expect((await step2({ accounts: [] })).status).toBe(401);
    expect((await step3({ removeCategoryIds: [], newCategories: [] })).status).toBe(401);
    expect((await skip({ step: 1 })).status).toBe(401);
    expect((await skipAll()).status).toBe(401);
  });
});

// ---------- GET /api/onboarding ----------

describe('TASK-159 GET /api/onboarding', () => {
  it('TASK-159 un usuario recién confirmado recibe 200 con un OnboardingDto en el paso 1', async () => {
    const { cookie, userId } = await activeAccount();

    const dto = onboardingOf(await onboarding(cookie));

    expect(dto.step).toBe(1);
    expect(dto.completed).toBe(false);
    expect(dto.presets.accounts).toEqual([
      { name: 'Efectivo (Bs)', type: 'cash', currencyCode: 'BOB', checked: true },
      { name: 'Banco (Bs)', type: 'bank', currencyCode: 'BOB', checked: true },
      { name: 'Dólares en efectivo ($)', type: 'cash', currencyCode: 'USD', checked: false },
    ]);
    const stored = await categoriesOf(userId);
    expect(treeIds(dto).sort()).toEqual(stored.map((row) => row.id).sort());
    const debts = dto.presets.categories.filter((node) => node.name === 'Deudas y préstamos');
    expect(debts.map((node) => node.kind).sort()).toEqual(['expense', 'income']);
    expect(debts.every((node) => node.isSystem)).toBe(true);
  });

  it('TASK-159 con el Onboarding terminado responde 409 ONBOARDING_DONE', async () => {
    const { cookie } = await accountIn(3, true);

    expectProblem(await onboarding(cookie), 409, 'ONBOARDING_DONE');
  });

  it('RF-M10-01 tras el paso 1 en una sesión, otra sesión del mismo usuario abre en el paso 2', async () => {
    const { email, cookie } = await activeAccount();
    expectSuccess(await step1({ baseCurrency: 'USD' }, cookie));

    const other = await post('/api/auth/sign-in', { email, password: PASSWORD });
    expect(other.status).toBe(200);
    const dto = onboardingOf(await onboarding(sessionCookieOf(other)));

    expect(dto.step).toBe(2);
    expect(dto.completed).toBe(false);
  });
});

// ---------- POST /api/onboarding/step1 ----------

describe('TASK-159 POST /api/onboarding/step1', () => {
  it('RF-M10-01 guarda la moneda base elegida y el Onboarding pasa al paso 2', async () => {
    const { cookie, userId } = await activeAccount();

    expectSuccess(await step1({ baseCurrency: 'USD' }, cookie));

    expect(await baseCurrencyOf(userId)).toBe('USD');
    expect(await progressOf(userId)).toEqual({ step: 2, completed: false });
    expect(onboardingOf(await onboarding(cookie)).step).toBe(2);
  });

  it('TASK-159 repetir el paso 1 responde 409 STEP_MISMATCH con el paso actual y no cambia la base', async () => {
    const { cookie, userId } = await activeAccount();
    expectSuccess(await step1({ baseCurrency: 'USD' }, cookie));

    expectStepMismatch(await step1({ baseCurrency: 'BOB' }, cookie), 2);

    expect(await baseCurrencyOf(userId)).toBe('USD');
    expect(await progressOf(userId)).toEqual({ step: 2, completed: false });
  });

  it('RF-M10-01 dos step1 simultáneos: uno avanza y el otro responde 409 STEP_MISMATCH', async () => {
    const { cookie, userId } = await activeAccount();

    const results = await Promise.all([
      step1({ baseCurrency: 'USD' }, cookie),
      step1({ baseCurrency: 'USD' }, cookie),
    ]);

    const succeeded = results.filter((res) => res.status >= 200 && res.status < 300);
    const rejected = results.filter((res) => res.status === 409);
    expect(succeeded).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    const [mismatch] = rejected;
    if (mismatch === undefined) throw new Error('no rejected step1');
    expectStepMismatch(mismatch, 2);
    expect(await progressOf(userId)).toEqual({ step: 2, completed: false });
  });

  it('TASK-159 una moneda que no es BOB ni USD responde 400 VALIDATION_ERROR y no avanza', async () => {
    const { cookie, userId } = await activeAccount();

    expectProblem(await step1({ baseCurrency: 'EUR' }, cookie), 400, 'VALIDATION_ERROR');

    expect(await baseCurrencyOf(userId)).toBe('BOB');
    expect(await progressOf(userId)).toEqual({ step: 1, completed: false });
  });

  it('TASK-159 con el Onboarding terminado responde 409 ONBOARDING_DONE y no cambia la base', async () => {
    const { cookie, userId } = await accountIn(1, true);

    expectProblem(await step1({ baseCurrency: 'USD' }, cookie), 409, 'ONBOARDING_DONE');

    expect(await baseCurrencyOf(userId)).toBe('BOB');
  });
});

// ---------- POST /api/onboarding/step2 ----------

describe('TASK-159 POST /api/onboarding/step2', () => {
  it('RF-M10-04 crea las cuentas con su saldo fechado hoy en la zona del usuario y pasa al paso 3', async () => {
    const { cookie, userId } = await activeAccount('Asia/Tokyo');
    await setOnboarding(userId, 2);
    const timezone = await timezoneOf(userId);
    const accounts = [
      entry('Efectivo (Bs)', 'cash', '150.50'),
      entry('Banco (Bs)', 'bank', '2300.00'),
    ];

    const before = container.clock.todayFor(timezone);
    const res = await step2({ accounts }, cookie);
    const after = container.clock.todayFor(timezone);

    expectSuccess(res);
    const stored = await accountsOf(userId);
    const fields = (account: StoredAccount | Step2Account) => ({
      id: account.id,
      type: account.type,
      name: account.name,
      currencyCode: account.currencyCode,
      balance: 'balance' in account ? account.balance : account.initialBalance,
    });
    expect(stored.map(fields)).toEqual([...accounts].sort(byId).map(fields));
    expect(stored.every((account) => account.status === 'active')).toBe(true);
    for (const account of stored) {
      expect([before, after]).toContain(account.initialBalanceDate);
    }
    expect(await progressOf(userId)).toEqual({ step: 3, completed: false });
  });

  it('EC-M10-02 dos cuentas con el mismo nombre responden 409 NAME_TAKEN y no se crea ninguna', async () => {
    const { cookie, userId } = await accountIn(2);
    const accounts = [entry('Banco (Bs)', 'bank', '100.00'), entry('Banco (Bs)', 'bank', '50.00')];

    expectProblem(await step2({ accounts }, cookie), 409, 'NAME_TAKEN');

    expect(await accountsOf(userId)).toEqual([]);
    expect(await progressOf(userId)).toEqual({ step: 2, completed: false });
  });

  it('EC-M10-01 un saldo negativo en el efectivo responde 400 VALIDATION_ERROR y no se crea ninguna', async () => {
    const { cookie, userId } = await accountIn(2);
    const accounts = [
      entry('Banco (Bs)', 'bank', '500.00'),
      entry('Efectivo (Bs)', 'cash', '-10.00'),
    ];

    expectProblem(await step2({ accounts }, cookie), 400, 'VALIDATION_ERROR');

    expect(await accountsOf(userId)).toEqual([]);
    expect(await progressOf(userId)).toEqual({ step: 2, completed: false });
  });

  it('TASK-159 más de 20 cuentas responden 400 VALIDATION_ERROR y no se crea ninguna', async () => {
    const { cookie, userId } = await accountIn(2);
    const accounts = Array.from({ length: 21 }, (_, i) => entry(`Cuenta ${i + 1}`, 'bank', '1.00'));

    expectProblem(await step2({ accounts }, cookie), 400, 'VALIDATION_ERROR');

    expect(await accountsOf(userId)).toEqual([]);
    expect(await progressOf(userId)).toEqual({ step: 2, completed: false });
  });

  it('TASK-159 en el paso 1 responde 409 STEP_MISMATCH con el paso actual y no crea cuentas', async () => {
    const { cookie, userId } = await activeAccount();

    expectStepMismatch(
      await step2({ accounts: [entry('Efectivo (Bs)', 'cash', '10.00')] }, cookie),
      1,
    );

    expect(await accountsOf(userId)).toEqual([]);
    expect(await progressOf(userId)).toEqual({ step: 1, completed: false });
  });

  it('TASK-159 reenviar el paso 2 con los mismos ids responde 409 STEP_MISMATCH y no duplica las cuentas', async () => {
    const { cookie, userId } = await accountIn(2);
    const accounts = [
      entry('Efectivo (Bs)', 'cash', '10.00'),
      entry('Banco (Bs)', 'bank', '20.00'),
    ];
    expectSuccess(await step2({ accounts }, cookie));
    const created = await accountsOf(userId);

    expectStepMismatch(await step2({ accounts }, cookie), 3);

    expect(created).toHaveLength(2);
    expect(await accountsOf(userId)).toEqual(created);
  });

  it('TASK-159 con el Onboarding terminado responde 409 ONBOARDING_DONE y no crea cuentas', async () => {
    const { cookie, userId } = await accountIn(2, true);

    expectProblem(
      await step2({ accounts: [entry('Efectivo (Bs)', 'cash', '10.00')] }, cookie),
      409,
      'ONBOARDING_DONE',
    );

    expect(await accountsOf(userId)).toEqual([]);
  });
});

// ---------- POST /api/onboarding/step3 ----------

describe('TASK-159 POST /api/onboarding/step3', () => {
  it('TASK-159 quita las desmarcadas con sus hijas, crea las nuevas y termina el Onboarding', async () => {
    const { cookie, userId } = await accountIn(3);
    const before = await categoriesOf(userId);
    const transport = named(before, 'expense', 'Transporte').id;
    const family = withChildren(before, transport);
    const mesada = named(before, 'income', 'Mesada').id;
    const gym = newCategory('expense', 'Gimnasio');

    expectSuccess(
      await step3({ removeCategoryIds: [transport, mesada], newCategories: [gym] }, cookie),
    );

    expect(family.length).toBeGreaterThan(1);
    expect(await categoriesOf(userId)).toEqual(
      [
        ...without(before, [...family, mesada]),
        { id: gym.id, kind: 'expense', parentId: null, name: 'Gimnasio', systemKey: null },
      ].sort(byId),
    );
    expect(await progressOf(userId)).toEqual({ step: 3, completed: true });
    expectProblem(await onboarding(cookie), 409, 'ONBOARDING_DONE');
  });

  it('RF-M10-05 quitar "Deudas y préstamos" responde 422 SYSTEM_CATEGORY y no cambia nada', async () => {
    const { cookie, userId } = await accountIn(3);
    const before = await categoriesOf(userId);
    const removable = named(before, 'expense', 'Ocio').id;
    const debts = debtsOf(before, 'expense').id;

    expectProblem(
      await step3(
        {
          removeCategoryIds: [removable, debts],
          newCategories: [newCategory('expense', 'Gimnasio')],
        },
        cookie,
      ),
      422,
      'SYSTEM_CATEGORY',
    );

    expect(await categoriesOf(userId)).toEqual(before);
    expect(await progressOf(userId)).toEqual({ step: 3, completed: false });
  });

  it('TASK-159 un id de categoría que no es un UUID responde 400 VALIDATION_ERROR y no termina', async () => {
    const { cookie, userId } = await accountIn(3);
    const before = await categoriesOf(userId);

    expectProblem(
      await step3({ removeCategoryIds: ['ocio'], newCategories: [] }, cookie),
      400,
      'VALIDATION_ERROR',
    );

    expect(await categoriesOf(userId)).toEqual(before);
    expect(await progressOf(userId)).toEqual({ step: 3, completed: false });
  });

  it('TASK-159 en el paso 2 responde 409 STEP_MISMATCH con el paso actual y no quita nada', async () => {
    const { cookie, userId } = await accountIn(2);
    const before = await categoriesOf(userId);

    expectStepMismatch(
      await step3(
        { removeCategoryIds: [named(before, 'expense', 'Ocio').id], newCategories: [] },
        cookie,
      ),
      2,
    );

    expect(await categoriesOf(userId)).toEqual(before);
    expect(await progressOf(userId)).toEqual({ step: 2, completed: false });
  });

  it('TASK-159 con el Onboarding terminado responde 409 ONBOARDING_DONE y no quita nada', async () => {
    const { cookie, userId } = await accountIn(3, true);
    const before = await categoriesOf(userId);

    expectProblem(
      await step3(
        { removeCategoryIds: [named(before, 'expense', 'Ocio').id], newCategories: [] },
        cookie,
      ),
      409,
      'ONBOARDING_DONE',
    );

    expect(await categoriesOf(userId)).toEqual(before);
  });
});

// ---------- POST /api/onboarding/skip and /skip-all ----------

describe('TASK-159 POST /api/onboarding/skip y /skip-all', () => {
  it('RF-M10-02 saltar el paso 1 deja BOB como moneda base y pasa al paso 2', async () => {
    const { cookie, userId } = await activeAccount();

    expectSuccess(await skip({ step: 1 }, cookie));

    expect(await baseCurrencyOf(userId)).toBe('BOB');
    expect(await progressOf(userId)).toEqual({ step: 2, completed: false });
  });

  it('RF-M10-03 saltar el paso 2 no crea cuentas y pasa al paso 3', async () => {
    const { cookie, userId } = await accountIn(2);

    expectSuccess(await skip({ step: 2 }, cookie));

    expect(await accountsOf(userId)).toEqual([]);
    expect(await progressOf(userId)).toEqual({ step: 3, completed: false });
  });

  it('RF-M10-06 saltar el paso 3 conserva todas las categorías y termina el Onboarding', async () => {
    const { cookie, userId } = await accountIn(3);
    const before = await categoriesOf(userId);

    expectSuccess(await skip({ step: 3 }, cookie));

    expect(await categoriesOf(userId)).toEqual(before);
    expect(await progressOf(userId)).toEqual({ step: 3, completed: true });
    expectProblem(await onboarding(cookie), 409, 'ONBOARDING_DONE');
  });

  it('TASK-159 saltar un paso que no es el pendiente responde 409 STEP_MISMATCH con el paso actual', async () => {
    const { cookie, userId } = await activeAccount();

    expectStepMismatch(await skip({ step: 2 }, cookie), 1);

    expect(await progressOf(userId)).toEqual({ step: 1, completed: false });
  });

  it('TASK-159 saltar un paso fuera de 1 a 3 responde 400 VALIDATION_ERROR', async () => {
    const { cookie, userId } = await activeAccount();

    expectProblem(await skip({ step: 4 }, cookie), 400, 'VALIDATION_ERROR');

    expect(await progressOf(userId)).toEqual({ step: 1, completed: false });
  });

  it('RF-M10-02 RF-M10-03 RF-M10-06 skip-all desde el paso 1 deja BOB, sin cuentas, con todas las categorías y terminado', async () => {
    const { cookie, userId } = await activeAccount();
    const before = await categoriesOf(userId);

    expectSuccess(await skipAll(cookie));

    expect(await baseCurrencyOf(userId)).toBe('BOB');
    expect(await accountsOf(userId)).toEqual([]);
    expect(await categoriesOf(userId)).toEqual(before);
    expect((await progressOf(userId)).completed).toBe(true);
    expectProblem(await onboarding(cookie), 409, 'ONBOARDING_DONE');
  });

  it('TASK-159 skip-all después del paso 1 conserva la moneda base elegida', async () => {
    const { cookie, userId } = await activeAccount();
    expectSuccess(await step1({ baseCurrency: 'USD' }, cookie));

    expectSuccess(await skipAll(cookie));

    expect(await baseCurrencyOf(userId)).toBe('USD');
    expect((await progressOf(userId)).completed).toBe(true);
  });

  it('TASK-159 con el Onboarding terminado, skip y skip-all responden 409 ONBOARDING_DONE', async () => {
    const { cookie, userId } = await accountIn(2, true);

    expectProblem(await skip({ step: 2 }, cookie), 409, 'ONBOARDING_DONE');
    expectProblem(await skipAll(cookie), 409, 'ONBOARDING_DONE');

    expect(await progressOf(userId)).toEqual({ step: 2, completed: true });
  });
});

// ---------- Isolation ----------

describe('RNF-14 aislamiento del Onboarding entre usuarios', () => {
  it('RNF-14 el Onboarding de un usuario no mueve ni termina el de otro', async () => {
    const a = await activeAccount();
    const b = await activeAccount();
    const categoriesOfB = await categoriesOf(b.userId);

    expectSuccess(await step1({ baseCurrency: 'USD' }, a.cookie));
    expectSuccess(await skip({ step: 2 }, a.cookie));
    expectSuccess(await skip({ step: 3 }, a.cookie));
    expectProblem(await onboarding(a.cookie), 409, 'ONBOARDING_DONE');

    const dto = onboardingOf(await onboarding(b.cookie));
    expect(dto.step).toBe(1);
    expect(dto.completed).toBe(false);
    expect(await progressOf(b.userId)).toEqual({ step: 1, completed: false });
    expect(await baseCurrencyOf(b.userId)).toBe('BOB');
    expect(await categoriesOf(b.userId)).toEqual(categoriesOfB);

    expectSuccess(await step1({ baseCurrency: 'BOB' }, b.cookie));
    expect(await progressOf(b.userId)).toEqual({ step: 2, completed: false });
    expect(await baseCurrencyOf(a.userId)).toBe('USD');
  });

  it('RNF-14 GET solo trae las categorías del propio usuario', async () => {
    const a = await activeAccount();
    const b = await activeAccount();

    const ids = treeIds(onboardingOf(await onboarding(a.cookie)));

    const own = (await categoriesOf(a.userId)).map((row) => row.id);
    const foreign = (await categoriesOf(b.userId)).map((row) => row.id);
    expect(ids.sort()).toEqual(own.sort());
    expect(ids.filter((id) => foreign.includes(id))).toEqual([]);
  });

  it('RNF-14 en el paso 2 los nombres de las cuentas de otro usuario no chocan ni se tocan', async () => {
    const a = await accountIn(2);
    const b = await accountIn(2);
    expectSuccess(await step2({ accounts: [entry('Efectivo (Bs)', 'cash', '30.00')] }, b.cookie));
    const accountsOfB = await accountsOf(b.userId);

    expectSuccess(await step2({ accounts: [entry('Efectivo (Bs)', 'cash', '70.00')] }, a.cookie));

    const accountsOfA = await accountsOf(a.userId);
    expect(accountsOfA.map((account) => [account.name, account.initialBalance])).toEqual([
      ['Efectivo (Bs)', '70.00'],
    ]);
    expect(await accountsOf(b.userId)).toEqual(accountsOfB);
  });

  it('RNF-14 en el paso 3 una categoría de otro usuario se comporta como inexistente', async () => {
    const withForeign = await accountIn(3);
    const withMissing = await accountIn(3);
    const b = await activeAccount();
    const categoriesOfB = await categoriesOf(b.userId);
    const foreignIds = [
      named(categoriesOfB, 'expense', 'Ocio').id,
      debtsOf(categoriesOfB, 'expense').id,
    ];
    const missingIds = [uuidv7(), uuidv7()];

    const foreign = await step3(
      { removeCategoryIds: foreignIds, newCategories: [] },
      withForeign.cookie,
    );
    const missing = await step3(
      { removeCategoryIds: missingIds, newCategories: [] },
      withMissing.cookie,
    );

    // The route answers: a success, or a problem with its code (ADR-09).
    const answered = missing.status < 300 || problem(missing).code !== undefined;
    expect(answered, `${missing.status} ${JSON.stringify(missing.body)}`).toBe(true);
    expect(foreign.status).toBe(missing.status);
    expect(problem(foreign).code).toBe(problem(missing).code);
    expect(await categoriesOf(b.userId)).toEqual(categoriesOfB);
    expect(await progressOf(b.userId)).toEqual({ step: 1, completed: false });
    expect(await progressOf(withForeign.userId)).toEqual(await progressOf(withMissing.userId));
  });
});
