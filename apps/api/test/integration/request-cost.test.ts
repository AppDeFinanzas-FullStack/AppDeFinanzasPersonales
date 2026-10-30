import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { DEFAULT_DASHBOARD_BLOCKS } from '@finanzas/contracts';
import type { Express } from 'express';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { buildContainer, createApp, type Container } from '../../src/composition/container.js';
import { parseEnv } from '../../src/infrastructure/config/env.js';
import { deleteLedgerOf } from '../factories/ledger.factory.js';
import { disconnectTestPrisma, testPrisma } from './setup/db.js';

/**
 * Cost of a request (plan §4.0 "Costo de una petición", §5.3; RNF-29). TASK-261 is a verification
 * task: it measures what the earlier tasks of the phase built, it does not build anything.
 *
 * The real app runs over the test database with fake integrations and `RELEASE=1.2`, so every
 * module answers. The user is the performance user of the `seed:e2e` seed (5.000 movements). The
 * number of database operations of a response comes from its `Server-Timing` header (`queries`,
 * TASK-254), and it is compared EXACTLY with the budget of the plan:
 * - `GET /api/me`: 8 or fewer;
 * - `GET /api/dashboard`: 35 or fewer;
 * - any other list: 12 or fewer.
 * A count does not show how much of it is chained, so the lists are repeated with
 * `DB_LATENCY_MS=25` (every Prisma operation waits 25 ms) and each one must answer in under
 * 400 ms (accounts and transactions keep the known debt, see the constants). That limit is measured as the best of several warm requests, so a slow machine does not
 * fail it but a chain of sequential reads does.
 */
const WEB_ORIGIN = 'http://localhost:5173';
const COOKIE_NAME = '__Secure-better-auth.session_token';
const SEED_PASSWORD = 'Prueba-E2E-2026';
const PERF_EMAIL = 'rendimiento@e2e.test';
const SEED_EMAILS = ['usuario-a@e2e.test', 'usuario-b@e2e.test', PERF_EMAIL];
const SEEDED_TRANSACTIONS = 5000;

const ME_BUDGET = 8;
const DASHBOARD_BUDGET = 35;
const LIST_BUDGET = 12;
const LATENCY_MS = 25;
const LIST_LIMIT_MS = 400;
// Known debt (plan §4.0 "Deuda conocida (TASK-261)"): accounts and transactions are fixed at what
// was measured. The target is still LIST_BUDGET queries and LIST_LIMIT_MS; lower these when it is met.
const ACCOUNTS_BUDGET = 21;
const TRANSACTIONS_BUDGET = 32;
const ACCOUNTS_LIMIT_MS = 900;
const TRANSACTIONS_LIMIT_MS = 1200;
const TIMED_SAMPLES = 5;

const SEED_TIMEOUT_MS = 240_000;
const SETUP_TIMEOUT_MS = SEED_TIMEOUT_MS + 120_000;
const TIMED_TEST_TIMEOUT_MS = 60_000;
const LA_PAZ_OFFSET_MS = 4 * 3_600_000;

const envSource = (extra: Record<string, string> = {}): Record<string, string> => ({
  NODE_ENV: 'test',
  PORT: '3000',
  DATABASE_URL: process.env['TEST_DATABASE_URL'] ?? '',
  AUTH_SECRET: 'auth-secret-value-0123456789abcdef0123456789',
  HMAC_SECRET: 'hmac-secret-value-0123456789abcdef0123456789',
  JOBS_SECRET: 'jobs-secret-value-0123456789abcdef0123456789',
  RESEND_API_KEY: 're_resend-key-value-0123456789',
  RELEASE: '1.2',
  WEB_ORIGIN,
  INTEGRATIONS: 'fake',
  ...extra,
});

const originalRelease = process.env['RELEASE'];
let container: Container;
let slowContainer: Container;
let app: Express;
let slowApp: Express;
let cookie = '';
let perfUserId = '';
let usersBefore: string[] = [];
let ratesBefore: string[] = [];

const todayInLaPaz = (): string =>
  new Date(Date.now() - LA_PAZ_OFFSET_MS).toISOString().slice(0, 10);

const month = (): string => todayInLaPaz().slice(0, 7);

/** The reads of the tabs, as the web asks for them (the list of the movements is one month). */
const paths = {
  me: '/api/me',
  dashboard: () => `/api/dashboard?month=${month()}`,
  accounts: '/api/accounts',
  transactions: () => `/api/transactions?month=${month()}`,
  categories: '/api/categories?kind=expense&status=active',
  budgets: '/api/budgets',
  goals: '/api/goals',
  debts: '/api/debts',
  recurring: '/api/recurring',
  rates: '/api/rates/current',
} as const;

type PathOf = string | (() => string);
const resolve = (path: PathOf): string => (typeof path === 'function' ? path() : path);

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

const read = (target: Express, path: PathOf) =>
  request(target).get(resolve(path)).set('Cookie', cookie);

/** Operations of a warm request: the first one pays the catch-up of the day and one-off work. */
async function warmQueries(path: PathOf): Promise<number> {
  const warm = await read(app, path);
  expect(warm.status, `GET ${resolve(path)}`).toBe(200);
  const res = await read(app, path);
  expect(res.status, `GET ${resolve(path)}`).toBe(200);
  return queriesOf(res);
}

/** The best time of several warm requests with 25 ms per operation. */
async function bestSlowTime(path: PathOf): Promise<number> {
  const warm = await read(slowApp, path);
  expect(warm.status, `GET ${resolve(path)}`).toBe(200);
  const times: number[] = [];
  for (let i = 0; i < TIMED_SAMPLES; i += 1) {
    const started = performance.now();
    const res = await read(slowApp, path);
    times.push(performance.now() - started);
    expect(res.status, `GET ${resolve(path)}`).toBe(200);
  }
  return Math.min(...times);
}

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
  cookie = sessionCookieOf(signIn);

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

describe('RNF-29 presupuesto de consultas por petición con el seed de 5.000 movimientos', () => {
  it('RNF-29 el seed deja 5.000 movimientos en el usuario de rendimiento', async () => {
    const rows = await testPrisma().$queryRaw<{ n: number }[]>`
      SELECT count(*)::int AS n FROM ledger_transaction
       WHERE user_id = ${perfUserId}::uuid AND deleted_at IS NULL`;
    expect(rows[0]?.n).toBeGreaterThanOrEqual(SEEDED_TRANSACTIONS);
  });

  it('RNF-29 GET /api/me ejecuta 8 consultas o menos', async () => {
    expect(await warmQueries(paths.me)).toBeLessThanOrEqual(ME_BUDGET);
  });

  it('RNF-29 GET /api/dashboard ejecuta 35 consultas o menos', async () => {
    expect(await warmQueries(paths.dashboard)).toBeLessThanOrEqual(DASHBOARD_BUDGET);
  });

  it('RNF-29 GET /api/accounts ejecuta 21 consultas o menos (deuda conocida, objetivo 12)', async () => {
    expect(await warmQueries(paths.accounts)).toBeLessThanOrEqual(ACCOUNTS_BUDGET);
  });

  it('RNF-29 GET /api/transactions ejecuta 32 consultas o menos (deuda conocida, objetivo 12)', async () => {
    expect(await warmQueries(paths.transactions)).toBeLessThanOrEqual(TRANSACTIONS_BUDGET);
  });

  it('RNF-29 GET /api/categories ejecuta 12 consultas o menos', async () => {
    expect(await warmQueries(paths.categories)).toBeLessThanOrEqual(LIST_BUDGET);
  });

  it('RNF-29 GET /api/budgets ejecuta 12 consultas o menos', async () => {
    expect(await warmQueries(paths.budgets)).toBeLessThanOrEqual(LIST_BUDGET);
  });

  it('RNF-29 GET /api/goals ejecuta 12 consultas o menos', async () => {
    expect(await warmQueries(paths.goals)).toBeLessThanOrEqual(LIST_BUDGET);
  });

  it('RNF-29 GET /api/debts ejecuta 12 consultas o menos', async () => {
    expect(await warmQueries(paths.debts)).toBeLessThanOrEqual(LIST_BUDGET);
  });

  it('RNF-29 GET /api/recurring (las reglas recurrentes) ejecuta 12 consultas o menos', async () => {
    expect(await warmQueries(paths.recurring)).toBeLessThanOrEqual(LIST_BUDGET);
  });

  it('RNF-29 GET /api/rates/current ejecuta 12 consultas o menos', async () => {
    expect(await warmQueries(paths.rates)).toBeLessThanOrEqual(LIST_BUDGET);
  });

  it('RNF-29 el costo en consultas no crece con las peticiones: tres seguidas de cada lista dan lo mismo', async () => {
    const lists: [PathOf, number][] = [
      [paths.accounts, ACCOUNTS_BUDGET],
      [paths.transactions, TRANSACTIONS_BUDGET],
      [paths.budgets, LIST_BUDGET],
      [paths.recurring, LIST_BUDGET],
    ];
    for (const [path, budget] of lists) {
      await read(app, path); // warm-up
      const counts: number[] = [];
      for (let i = 0; i < 3; i += 1) {
        counts.push(queriesOf(await read(app, path)));
      }
      expect(Math.max(...counts), resolve(path)).toBe(Math.min(...counts));
      expect(Math.max(...counts), resolve(path)).toBeLessThanOrEqual(budget);
    }
  });
});

describe('RNF-29 con 25 ms de latencia simulada por consulta cada lista responde en menos de 400 ms', () => {
  it(
    'RNF-29 con DB_LATENCY_MS=25 GET /api/accounts responde en menos de 900 ms (deuda conocida, objetivo 400 ms)',
    async () => {
      expect(await bestSlowTime(paths.accounts)).toBeLessThan(ACCOUNTS_LIMIT_MS);
    },
    TIMED_TEST_TIMEOUT_MS,
  );

  it(
    'RNF-29 con DB_LATENCY_MS=25 GET /api/transactions responde en menos de 1200 ms (deuda conocida, objetivo 400 ms)',
    async () => {
      expect(await bestSlowTime(paths.transactions)).toBeLessThan(TRANSACTIONS_LIMIT_MS);
    },
    TIMED_TEST_TIMEOUT_MS,
  );

  it(
    'RNF-29 con DB_LATENCY_MS=25 GET /api/categories responde en menos de 400 ms',
    async () => {
      expect(await bestSlowTime(paths.categories)).toBeLessThan(LIST_LIMIT_MS);
    },
    TIMED_TEST_TIMEOUT_MS,
  );

  it(
    'RNF-29 con DB_LATENCY_MS=25 GET /api/budgets responde en menos de 400 ms',
    async () => {
      expect(await bestSlowTime(paths.budgets)).toBeLessThan(LIST_LIMIT_MS);
    },
    TIMED_TEST_TIMEOUT_MS,
  );

  it(
    'RNF-29 con DB_LATENCY_MS=25 GET /api/goals responde en menos de 400 ms',
    async () => {
      expect(await bestSlowTime(paths.goals)).toBeLessThan(LIST_LIMIT_MS);
    },
    TIMED_TEST_TIMEOUT_MS,
  );

  it(
    'RNF-29 con DB_LATENCY_MS=25 GET /api/debts responde en menos de 400 ms',
    async () => {
      expect(await bestSlowTime(paths.debts)).toBeLessThan(LIST_LIMIT_MS);
    },
    TIMED_TEST_TIMEOUT_MS,
  );

  it(
    'RNF-29 con DB_LATENCY_MS=25 GET /api/recurring (las reglas recurrentes) responde en menos de 400 ms',
    async () => {
      expect(await bestSlowTime(paths.recurring)).toBeLessThan(LIST_LIMIT_MS);
    },
    TIMED_TEST_TIMEOUT_MS,
  );

  it(
    'RNF-29 con DB_LATENCY_MS=25 GET /api/rates/current responde en menos de 400 ms',
    async () => {
      expect(await bestSlowTime(paths.rates)).toBeLessThan(LIST_LIMIT_MS);
    },
    TIMED_TEST_TIMEOUT_MS,
  );
});
