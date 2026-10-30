import { createHmac, randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { DEFAULT_DASHBOARD_BLOCKS, type DashboardViewDto } from '@finanzas/contracts';
import type { Express } from 'express';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { buildContainer, createApp, type Container } from '../../src/composition/container.js';
import { parseEnv } from '../../src/infrastructure/config/env.js';
import { createAccount } from '../factories/account.factory.js';
import { createCategory } from '../factories/category.factory.js';
import { createLedgerTransaction, deleteLedgerOf } from '../factories/ledger.factory.js';
import { disconnectTestPrisma, testPrisma } from './setup/db.js';

/**
 * Cost of `GET /api/dashboard` (plan §4.0 "Un endpoint, pocas transacciones", §4.8.2; RNF-03,
 * RNF-29). The real app runs over the test database with fake integrations and `RELEASE=1.2`, so
 * every block of the Inicio is computed. The number of database operations of a response comes
 * from its `Server-Timing` header (`queries`, TASK-254); the app with `DB_LATENCY_MS=25` makes
 * every operation wait 25 ms, so a chain of reads shows up as time.
 *
 * Two kinds of data are used:
 * - the performance user of the `seed:e2e` seed (5.000 movements), for the budget of operations
 *   and the time of the Inicio;
 * - a user with a small, hand-made ledger in past months, for the exact answer (RF-M8-01) and for
 *   the hidden blocks.
 * The time limits are the ones of the task (700 ms), measured as the best of several warm requests,
 * so a slow machine does not fail them but a chain of sequential reads does.
 */
const WEB_ORIGIN = 'http://localhost:5173';
const COOKIE_NAME = '__Secure-better-auth.session_token';
const HMAC_SECRET = 'hmac-secret-value-0123456789abcdef0123456789';
const PASSWORD = 'Clave-segura-123';
const SEED_PASSWORD = 'Prueba-E2E-2026';
const PERF_EMAIL = 'rendimiento@e2e.test';
const SEED_EMAILS = ['usuario-a@e2e.test', 'usuario-b@e2e.test', PERF_EMAIL];
const SEEDED_TRANSACTIONS = 5000;

const QUERY_BUDGET = 35;
const LATENCY_MS = 25;
const HOME_LIMIT_MS = 700;
const TIMED_SAMPLES = 3;

const SEED_TIMEOUT_MS = 240_000;
const SETUP_TIMEOUT_MS = SEED_TIMEOUT_MS + 120_000;
const LA_PAZ_OFFSET_MS = 4 * 3_600_000;
const PAST_MONTH = '2025-03';

const envSource = (extra: Record<string, string> = {}): Record<string, string> => ({
  NODE_ENV: 'test',
  PORT: '3000',
  DATABASE_URL: process.env['TEST_DATABASE_URL'] ?? '',
  AUTH_SECRET: 'auth-secret-value-0123456789abcdef0123456789',
  HMAC_SECRET,
  JOBS_SECRET: 'jobs-secret-value-0123456789abcdef0123456789',
  RESEND_API_KEY: 're_resend-key-value-0123456789',
  RELEASE: '1.2',
  WEB_ORIGIN,
  INTEGRATIONS: 'fake',
  ...extra,
});

interface MovementBody {
  id: string;
  kind: string;
  date: string;
}
interface AccountBody {
  id: string;
  name: string;
  balance: string;
}
interface AccountsListBody {
  items: AccountBody[];
  summary: { netWorth: { base: string | null; other: string | null } };
}
interface TransactionsListBody {
  items: MovementBody[];
}
type HomeBody = Omit<DashboardViewDto, 'recent' | 'balances'> & {
  recent?: MovementBody[];
  balances?: {
    netWorth: { base: string; other: string | null };
    top: AccountBody[];
    asOfToday: boolean;
  };
};

const originalRelease = process.env['RELEASE'];
let container: Container;
let slowContainer: Container;
let app: Express;
let slowApp: Express;
let perfCookie = '';
let perfUserId = '';
let usersBefore: string[] = [];
let ratesBefore: string[] = [];
const usedEmails = new Set<string>();
const usedUserIds: string[] = [];

const hmacOf = (email: string) =>
  createHmac('sha256', HMAC_SECRET).update(email.trim().toLowerCase()).digest('hex');

const todayInLaPaz = (): string =>
  new Date(Date.now() - LA_PAZ_OFFSET_MS).toISOString().slice(0, 10);

function runSeed(): void {
  const url = process.env['TEST_DATABASE_URL'];
  if (!url) {
    throw new Error('TEST_DATABASE_URL is not set');
  }
  const result = spawnSync('pnpm', ['run', 'seed:e2e'], {
    cwd: fileURLToPath(new URL('../../../../packages/db/', import.meta.url)),
    env: { ...process.env, DATABASE_URL: url, DATABASE_URL_DIRECT: url },
    encoding: 'utf8',
    shell: process.platform === 'win32',
    timeout: SEED_TIMEOUT_MS,
  });
  if (result.status !== 0) {
    throw new Error(
      `seed:e2e exited with ${String(result.status)}\n${result.stdout}\n${result.stderr}`,
    );
  }
}

async function seedKeys(): Promise<{ users: string[]; rates: string[] }> {
  const db = testPrisma();
  const users = await db.$queryRaw<{ id: string }[]>`
    SELECT id::text AS id FROM auth_user WHERE email = ANY(${SEED_EMAILS}::text[])`;
  const rates = await db.$queryRaw<{ key: string }[]>`
    SELECT kind::text || '|' || to_char(rate_date, 'YYYY-MM-DD') AS key FROM market_rate`;
  return { users: users.map((r) => r.id), rates: rates.map((r) => r.key) };
}

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

const homeOf = (target: Express, month: string, cookie: string) =>
  request(target).get(`/api/dashboard?month=${month}`).set('Cookie', cookie);

const get = (path: string, cookie: string) => request(app).get(path).set('Cookie', cookie);

const bodyOf = (res: { body: unknown }) => res.body as HomeBody;

beforeAll(async () => {
  process.env['RELEASE'] = '1.2';
  const before = await seedKeys();
  usersBefore = before.users;
  ratesBefore = before.rates;

  runSeed();

  const db = testPrisma();
  await db.$executeRaw`ANALYZE ledger_transaction`;
  await db.$executeRaw`ANALYZE ledger_entry`;

  container = buildContainer(parseEnv(envSource()));
  app = createApp(container);
  slowContainer = buildContainer(parseEnv(envSource({ DB_LATENCY_MS: String(LATENCY_MS) })));
  slowApp = createApp(slowContainer);

  const signIn = await request(app)
    .post('/api/auth/sign-in')
    .set('Origin', WEB_ORIGIN)
    .send({ email: PERF_EMAIL, password: SEED_PASSWORD });
  expect(signIn.status).toBe(200);
  perfCookie = sessionCookieOf(signIn);

  const users = await db.$queryRaw<{ id: string }[]>`
    SELECT id::text AS id FROM auth_user WHERE email = ${PERF_EMAIL}`;
  perfUserId = users[0]?.id ?? '';
  expect(perfUserId).not.toBe('');
  // Every block of the Inicio visible, whatever another suite left in the settings.
  await db.$executeRaw`
    UPDATE user_settings SET dashboard_blocks = ${JSON.stringify(DEFAULT_DASHBOARD_BLOCKS)}::jsonb
     WHERE user_id = ${perfUserId}::uuid`;
}, SETUP_TIMEOUT_MS);

afterAll(async () => {
  if (originalRelease === undefined) delete process.env['RELEASE'];
  else process.env['RELEASE'] = originalRelease;
  try {
    const db = testPrisma();
    const emails = [...usedEmails];
    await deleteLedgerOf(usedUserIds);
    await db.$executeRaw`DELETE FROM auth_user WHERE email = ANY(${emails}::text[])`;
    await db.$executeRaw`DELETE FROM email_outbox WHERE to_address = ANY(${emails}::text[])`;
    await db.$executeRaw`
      DELETE FROM email_send_log WHERE email_hmac = ANY(${emails.map(hmacOf)}::text[])`;
    // The seed users are removed only when this file created them.
    const known = new Set(usersBefore);
    const after = await seedKeys();
    const added = after.users.filter((id) => !known.has(id));
    if (added.length > 0) {
      await deleteLedgerOf(added);
      await db.$executeRaw`
        DELETE FROM category WHERE user_id = ANY(${added}::uuid[]) AND parent_id IS NOT NULL`;
      await db.$executeRaw`DELETE FROM auth_user WHERE id = ANY(${added}::uuid[])`;
    }
    const knownRates = new Set(ratesBefore);
    const extraRates = after.rates.filter((key) => !knownRates.has(key));
    if (extraRates.length > 0) {
      await db.$executeRaw`
        DELETE FROM market_rate
         WHERE kind::text || '|' || to_char(rate_date, 'YYYY-MM-DD') = ANY(${extraRates}::text[])`;
    }
  } finally {
    await container.prisma.$disconnect();
    await slowContainer.prisma.$disconnect();
    await disconnectTestPrisma();
  }
}, 120_000);

interface Fixture {
  userId: string;
  cookie: string;
}

/** A confirmed account with a session, made through the real sign-up flow. */
async function activeAccount(): Promise<Fixture> {
  const email = `${randomUUID()}@integration-dashboard-cost.test`;
  usedEmails.add(email);
  const up = await request(app)
    .post('/api/auth/sign-up')
    .set('Origin', WEB_ORIGIN)
    .send({ name: 'Ana Pérez', email, password: PASSWORD, acceptTerms: true });
  expect(up.status).toBe(202);
  const links = await testPrisma().$queryRaw<{ link: string | null }[]>`
    SELECT payload->>'link' AS link FROM email_outbox
    WHERE to_address = ${email} AND kind = 'confirm'::email_kind
    ORDER BY created_at DESC, id DESC LIMIT 1`;
  const token = /[A-Za-z0-9_-]{43}/.exec(links[0]?.link ?? '')?.[0];
  if (token === undefined) throw new Error('no confirmation token');
  const confirmed = await request(app)
    .post('/api/auth/confirm')
    .set('Origin', WEB_ORIGIN)
    .send({ token });
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
  return { userId, cookie: sessionCookieOf(res) };
}

async function setBlocks(cookie: string, visible: string[]): Promise<void> {
  const blocks = DEFAULT_DASHBOARD_BLOCKS.map((b) => ({ ...b, visible: visible.includes(b.key) }));
  const res = await request(app)
    .patch('/api/settings')
    .set('Origin', WEB_ORIGIN)
    .set('Cookie', cookie)
    .send({ dashboardBlocks: blocks });
  expect(res.status).toBe(200);
}

/** Operations of the Inicio with that visible set, measured after one warm-up request. */
async function queriesWith(cookie: string, visible: string[]): Promise<number> {
  await setBlocks(cookie, visible);
  await homeOf(app, PAST_MONTH, cookie); // catch-up and one-off work
  const res = await homeOf(app, PAST_MONTH, cookie);
  expect(res.status).toBe(200);
  return queriesOf(res);
}

describe('RNF-03 costo de GET /api/dashboard con el seed de 5.000 movimientos', () => {
  const month = () => todayInLaPaz().slice(0, 7);

  it('RNF-03 el seed deja 5.000 movimientos en el usuario de rendimiento', async () => {
    const rows = await testPrisma().$queryRaw<{ n: number }[]>`
      SELECT count(*)::int AS n FROM ledger_transaction
       WHERE user_id = ${perfUserId}::uuid AND deleted_at IS NULL`;
    expect(rows[0]?.n).toBeGreaterThanOrEqual(SEEDED_TRANSACTIONS);
  });

  it('RNF-03 con todos los bloques visibles la respuesta trae los seis bloques', async () => {
    const res = await homeOf(app, month(), perfCookie);

    expect(res.status).toBe(200);
    const body = bodyOf(res);
    expect(body.budgets).toBeDefined();
    expect(body.upcoming).toBeDefined();
    expect(body.byCategory).toBeDefined();
    expect(body.pace).toBeDefined();
    expect(body.balances).toBeDefined();
    expect(body.recent).toBeDefined();
  });

  it('RNF-03 GET /api/dashboard ejecuta 35 consultas o menos con todos los bloques visibles', async () => {
    await homeOf(app, month(), perfCookie); // warms the connection and the one-off work

    const res = await homeOf(app, month(), perfCookie);

    expect(res.status).toBe(200);
    expect(queriesOf(res)).toBeLessThanOrEqual(QUERY_BUDGET);
  });

  it('RNF-29 el costo en consultas no crece con las peticiones: tres seguidas dentro del presupuesto', async () => {
    await homeOf(app, month(), perfCookie);

    const counts: number[] = [];
    for (let i = 0; i < 3; i += 1) {
      counts.push(queriesOf(await homeOf(app, month(), perfCookie)));
    }

    for (const count of counts) {
      expect(count).toBeLessThanOrEqual(QUERY_BUDGET);
    }
    expect(Math.max(...counts)).toBe(Math.min(...counts));
  });

  it('RNF-03 un mes pasado con todos los bloques también cabe en 35 consultas', async () => {
    await homeOf(app, PAST_MONTH, perfCookie);

    const res = await homeOf(app, PAST_MONTH, perfCookie);

    expect(res.status).toBe(200);
    expect(queriesOf(res)).toBeLessThanOrEqual(QUERY_BUDGET);
  });

  it('RNF-03 con DB_LATENCY_MS=25 el mismo GET /api/dashboard sigue en 35 consultas o menos', async () => {
    await homeOf(slowApp, month(), perfCookie);

    const res = await homeOf(slowApp, month(), perfCookie);

    expect(res.status).toBe(200);
    expect(queriesOf(res)).toBeLessThanOrEqual(QUERY_BUDGET);
  });

  it('RNF-03 con DB_LATENCY_MS=25 GET /api/dashboard responde en menos de 700 ms', async () => {
    const warm = await homeOf(slowApp, month(), perfCookie);
    expect(warm.status).toBe(200);

    // The best of several warm requests: a loaded machine slows a sample, a chain of
    // sequential reads slows all of them.
    const times: number[] = [];
    for (let i = 0; i < TIMED_SAMPLES; i += 1) {
      const started = performance.now();
      const res = await homeOf(slowApp, month(), perfCookie);
      times.push(performance.now() - started);
      expect(res.status).toBe(200);
    }

    expect(Math.min(...times)).toBeLessThan(HOME_LIMIT_MS);
  }, 60_000);
});

describe('RF-M8-01 la respuesta del Inicio es la misma con los mismos datos', () => {
  it('RF-M8-01 con el usuario del seed dos peticiones seguidas dan la misma respuesta', async () => {
    const first = await homeOf(app, todayInLaPaz().slice(0, 7), perfCookie);
    const second = await homeOf(slowApp, todayInLaPaz().slice(0, 7), perfCookie);

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(second.body).toEqual(first.body);
  });

  it('RF-M8-01 las cuentas y el patrimonio del Inicio son los de GET /api/accounts', async () => {
    const home = bodyOf(await homeOf(app, todayInLaPaz().slice(0, 7), perfCookie));
    const accounts = (await get('/api/accounts', perfCookie)).body as AccountsListBody;

    expect(home.balances?.asOfToday).toBe(true);
    expect(home.balances?.top).toEqual(accounts.items.slice(0, 5));
    expect(home.balances?.netWorth.base).toBe(accounts.summary.netWorth.base ?? '0.00');
    expect(home.balances?.netWorth.other).toBe(accounts.summary.netWorth.other);
  });

  it('RF-M8-01 los movimientos recientes del Inicio son los 5 primeros de GET /api/transactions', async () => {
    const today = todayInLaPaz();
    const home = bodyOf(await homeOf(app, today.slice(0, 7), perfCookie));
    const firstMonth = home.range.firstMonth;
    const list = (
      await get(`/api/transactions?from=${firstMonth}-01&to=${today}&limit=5`, perfCookie)
    ).body as TransactionsListBody;

    expect(home.recent).toHaveLength(5);
    expect(home.recent).toEqual(list.items.slice(0, 5));
  });

  it('RF-M8-01 con un historial conocido el Inicio da las mismas tarjetas, variaciones y bloques', async () => {
    const { userId, cookie } = await activeAccount();
    const cash = await createAccount(userId, {
      name: 'Caja golden',
      initialBalance: '100.00',
      initialBalanceDate: '2020-01-01',
    });
    const savings = await createAccount(userId, {
      type: 'savings',
      name: 'Ahorro golden',
      initialBalance: '50.00',
      initialBalanceDate: '2020-01-01',
    });
    const food = await createCategory(userId, { kind: 'expense', name: 'Comida golden' });
    const transport = await createCategory(userId, { kind: 'expense', name: 'Transporte golden' });
    const leisure = await createCategory(userId, { kind: 'expense', name: 'Ocio golden' });
    const salary = await createCategory(userId, { kind: 'income', name: 'Sueldo golden' });
    const spend = (date: string, amount: string, accountId: string, categoryId: string) =>
      createLedgerTransaction(userId, {
        kind: 'expense',
        date,
        categoryId,
        entries: [{ accountId, amount: `-${amount}` }],
      });
    const earn = (date: string, amount: string) =>
      createLedgerTransaction(userId, {
        kind: 'income',
        date,
        categoryId: salary.id,
        entries: [{ accountId: cash.id, amount }],
      });
    await spend('2025-02-10', '20.00', cash.id, food.id);
    await earn('2025-02-20', '300.00');
    await spend('2025-03-02', '10.00', cash.id, food.id);
    await earn('2025-03-05', '500.00');
    const fare = await spend('2025-03-10', '40.00', cash.id, transport.id);
    const cinema = await spend('2025-03-12', '25.00', savings.id, leisure.id);
    const transfer = await createLedgerTransaction(userId, {
      kind: 'transfer',
      date: '2025-03-15',
      entries: [
        { accountId: cash.id, amount: '-30.00' },
        { accountId: savings.id, amount: '30.00' },
      ],
    });
    const lunch = await spend('2025-03-20', '5.00', cash.id, food.id);
    const bus = await spend('2025-03-21', '7.00', savings.id, transport.id);

    const res = await homeOf(app, PAST_MONTH, cookie);
    const accounts = (await get('/api/accounts', cookie)).body as AccountsListBody;

    expect(res.status).toBe(200);
    const body = bodyOf(res);
    // Income 500 and expense 87 (the transfer is neither); the month before: 300 and 20.
    expect(body.range.firstMonth).toBe('2020-01');
    expect(body.range.currentMonth).toMatch(/^\d{4}-\d{2}$/);
    expect(body.cards).toEqual({
      income: '500.00',
      expense: '87.00',
      balance: '413.00',
      savingsRatePct: 83,
      variations: { income: '+67%', expense: '+335%', balance: '133.00', savingsRatePp: -10 },
    });
    expect(body.budgets).toEqual([]);
    expect(body).not.toHaveProperty('upcoming');
    expect(body.byCategory).toEqual({
      top: [
        { categoryId: transport.id, name: 'Transporte golden', amount: '47.00', pct: 54 },
        { categoryId: leisure.id, name: 'Ocio golden', amount: '25.00', pct: 28.7 },
        { categoryId: food.id, name: 'Comida golden', amount: '15.00', pct: 17.2 },
      ],
      others: null,
    });
    const cumulative = (points: { day: number; cumulative: string }[] | undefined) =>
      Object.fromEntries((points ?? []).map((p) => [p.day, p.cumulative]));
    const current = cumulative(body.pace?.current);
    const previous = cumulative(body.pace?.previous);
    expect(Object.keys(current)).toHaveLength(31);
    expect(Object.keys(previous)).toHaveLength(28);
    expect([1, 2, 9, 10, 12, 19, 20, 21, 31].map((day) => current[day])).toEqual([
      '0.00',
      '10.00',
      '10.00',
      '50.00',
      '75.00',
      '75.00',
      '80.00',
      '87.00',
      '87.00',
    ]);
    expect([1, 9, 10, 28].map((day) => previous[day])).toEqual(['0.00', '0.00', '20.00', '20.00']);
    // Balances are today's: 100 - 20 + 300 - 10 + 500 - 40 - 30 - 5 and 50 - 25 + 30 - 7.
    expect(body.balances?.asOfToday).toBe(true);
    expect(body.balances?.netWorth.base).toBe('843.00');
    expect(body.balances?.netWorth.other).toBe(accounts.summary.netWorth.other);
    expect(body.balances?.top.map((a) => [a.id, a.balance])).toEqual([
      [cash.id, '795.00'],
      [savings.id, '48.00'],
    ]);
    expect(body.recent?.map((m) => [m.id, m.kind, m.date])).toEqual([
      [bus.id, 'expense', '2025-03-21'],
      [lunch.id, 'expense', '2025-03-20'],
      [transfer.id, 'transfer', '2025-03-15'],
      [cinema.id, 'expense', '2025-03-12'],
      [fare.id, 'expense', '2025-03-10'],
    ]);
  });
});

describe('RNF-03 los bloques de gráficos ocultos no leen ningún gasto', () => {
  it('RNF-03 sin "Por categoría" ni "Ritmo" el Inicio hace menos consultas que con ellos', async () => {
    const { cookie } = await activeAccount();
    const all = DEFAULT_DASHBOARD_BLOCKS.map((b) => b.key as string);
    const withoutCharts = all.filter((key) => key !== 'byCategory' && key !== 'pace');

    const visible = await queriesWith(cookie, all);
    const hidden = await queriesWith(cookie, withoutCharts);

    expect(hidden).toBeLessThan(visible);
  });

  it('RNF-03 con los dos gráficos ocultos la respuesta no trae "byCategory" ni "pace"', async () => {
    const { cookie } = await activeAccount();
    await setBlocks(cookie, ['budget', 'upcoming', 'balances', 'recent']);

    const res = await homeOf(app, PAST_MONTH, cookie);

    expect(res.status).toBe(200);
    expect(res.body).not.toHaveProperty('byCategory');
    expect(res.body).not.toHaveProperty('pace');
    expect(res.body).toHaveProperty('balances');
    expect(res.body).toHaveProperty('recent');
  });

  it('RNF-03 la lectura de gastos cuesta lo mismo con uno o con los dos gráficos: se lee una vez', async () => {
    const { cookie } = await activeAccount();

    const none = await queriesWith(cookie, []);
    const categoriesOnly = await queriesWith(cookie, ['byCategory']);
    const paceOnly = await queriesWith(cookie, ['pace']);
    const both = await queriesWith(cookie, ['byCategory', 'pace']);

    expect(categoriesOnly).toBeGreaterThan(none);
    expect(paceOnly).toBeGreaterThan(none);
    expect(categoriesOnly).toBe(paceOnly);
    expect(both).toBe(categoriesOnly);
  });

  it('RNF-03 con todos los bloques ocultos solo se leen las tarjetas: menos consultas que con todos', async () => {
    const { cookie } = await activeAccount();
    const all = DEFAULT_DASHBOARD_BLOCKS.map((b) => b.key as string);

    const visible = await queriesWith(cookie, all);
    const cardsOnly = await queriesWith(cookie, []);

    expect(cardsOnly).toBeLessThan(visible);
  });
});
