import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import type { DashboardViewDto } from '@finanzas/contracts';
import type { Express } from 'express';
import request from 'supertest';
import { uuidv7 } from 'uuidv7';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { buildContainer, createApp, type Container } from '../../src/composition/container.js';
import { parseEnv } from '../../src/infrastructure/config/env.js';
import type { TransactionClient } from '../../src/infrastructure/persistence/unit-of-work.js';
import { deleteLedgerOf } from '../factories/ledger.factory.js';
import { disconnectTestPrisma, testPrisma } from './setup/db.js';

/**
 * Performance of the API against Postgres with the `seed:e2e` seed (TASK-166: 5.000 movements
 * over 12 months for the performance user). Plan §5.3 fixes what is measured: the p95 of 200
 * `POST /api/transactions` is under 300 ms in the server (RNF-02) and the p95 of
 * `GET /api/dashboard` is under 1,2 s (plan §4.8.2, RNF-03), and `EXPLAIN ANALYZE` of the queries
 * of the Inicio shows no sequential scan over `ledger_transaction` nor `ledger_entry` (RNF-03).
 *
 * The requests go through the real app, in process, one after another, and each one is timed from
 * its dispatch to its answer, so the figure includes the HTTP stack, Better Auth and the database.
 *
 * About the plans: with 5.000 rows the planner may price a sequential scan under an index scan
 * and pick it, which says nothing about production. The plans are therefore taken with
 * `enable_seqscan = off` after an `ANALYZE`: a ledger table then appears in a "Seq Scan" node only
 * when no index serves the query (the indexes `ledger_tx_list` and `ledger_entry_balance`, plan
 * §4.8.2). The queries are those the Inicio runs (dashboard, ledger and account repositories).
 */
const WEB_ORIGIN = 'http://localhost:5173';
const COOKIE_NAME = '__Secure-better-auth.session_token';
const SEED_PASSWORD = 'Prueba-E2E-2026';
const PERF_EMAIL = 'rendimiento@e2e.test';
const SEED_EMAILS = ['usuario-a@e2e.test', 'usuario-b@e2e.test', PERF_EMAIL];
const SEEDED_TRANSACTIONS = 5000;

const SAVE_SAMPLES = 200;
const HOME_SAMPLES = 50;
const SAVE_P95_LIMIT_MS = 300;
const HOME_P95_LIMIT_MS = 1200;

const SEED_TIMEOUT_MS = 240_000;
const SETUP_TIMEOUT_MS = SEED_TIMEOUT_MS + 120_000;
const RUN_TIMEOUT_MS = 180_000;
const LA_PAZ_OFFSET_MS = 4 * 3_600_000;

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

let container: Container;
let app: Express;
let cookie = '';
let userId = '';
let accountId = '';
let categoryId = '';
let usersBefore: string[] = [];
let ratesBefore: string[] = [];
const createdIds: string[] = [];

const todayInLaPaz = (): string =>
  new Date(Date.now() - LA_PAZ_OFFSET_MS).toISOString().slice(0, 10);

/** The p95 by nearest rank: the smallest sample with 95 % of the samples at or below it. */
function p95(samples: number[]): number {
  const sorted = [...samples].sort((a, b) => a - b);
  const value = sorted[Math.ceil(sorted.length * 0.95) - 1];
  if (value === undefined) {
    throw new Error('no samples');
  }
  return value;
}

async function timed(send: () => Promise<{ status: number }>): Promise<{
  status: number;
  ms: number;
}> {
  const started = performance.now();
  const res = await send();
  return { status: res.status, ms: performance.now() - started };
}

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
    timeout: RUN_TIMEOUT_MS,
  });
  if (result.status !== 0) {
    throw new Error(
      `seed:e2e exited with ${String(result.status)}\n${result.stdout}\n${result.stderr}`,
    );
  }
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

const savedExpense = (id: string) => ({
  kind: 'expense',
  id,
  accountId,
  categoryId,
  amount: '1.00',
  date: todayInLaPaz(),
});

const saveExpense = (id: string) =>
  request(app)
    .post('/api/transactions')
    .set('Origin', WEB_ORIGIN)
    .set('Cookie', cookie)
    .send(savedExpense(id));

const homeOf = (month: string) =>
  request(app).get(`/api/dashboard?month=${month}`).set('Cookie', cookie);

async function seedKeys(): Promise<{ users: string[]; rates: string[] }> {
  const db = testPrisma();
  const users = await db.$queryRaw<{ id: string }[]>`
    SELECT id::text AS id FROM auth_user WHERE email = ANY(${SEED_EMAILS}::text[])`;
  const rates = await db.$queryRaw<{ key: string }[]>`
    SELECT kind::text || '|' || to_char(rate_date, 'YYYY-MM-DD') AS key FROM market_rate`;
  return { users: users.map((r) => r.id), rates: rates.map((r) => r.key) };
}

beforeAll(async () => {
  const before = await seedKeys();
  usersBefore = before.users;
  ratesBefore = before.rates;

  runSeed();

  const db = testPrisma();
  // Fresh statistics, as autovacuum would have after loading 5.000 movements.
  await db.$executeRaw`ANALYZE ledger_transaction`;
  await db.$executeRaw`ANALYZE ledger_entry`;

  container = await Promise.resolve(buildContainer(parseEnv(envSource())));
  app = await Promise.resolve(createApp(container));

  const signIn = await request(app)
    .post('/api/auth/sign-in')
    .set('Origin', WEB_ORIGIN)
    .send({ email: PERF_EMAIL, password: SEED_PASSWORD });
  expect(signIn.status).toBe(200);
  cookie = sessionCookieOf(signIn);

  const users = await db.$queryRaw<{ id: string }[]>`
    SELECT id::text AS id FROM auth_user WHERE email = ${PERF_EMAIL}`;
  userId = users[0]?.id ?? '';
  expect(userId).not.toBe('');

  const accounts = await db.$queryRaw<{ id: string }[]>`
    SELECT id::text AS id FROM account
     WHERE user_id = ${userId}::uuid AND currency_code = 'BOB' AND status = 'active'
     ORDER BY initial_balance DESC, sort_order LIMIT 1`;
  accountId = accounts[0]?.id ?? '';
  const categories = await db.$queryRaw<{ id: string }[]>`
    SELECT c.id::text AS id FROM category c
     WHERE c.user_id = ${userId}::uuid AND c.kind = 'expense' AND c.status = 'active'
       AND c.system_key IS NULL
       AND NOT EXISTS (SELECT 1 FROM category k WHERE k.user_id = c.user_id AND k.parent_id = c.id)
     ORDER BY c.sort_order, c.id LIMIT 1`;
  categoryId = categories[0]?.id ?? '';
  expect(accountId).not.toBe('');
  expect(categoryId).not.toBe('');
}, SETUP_TIMEOUT_MS);

afterAll(async () => {
  try {
    const db = testPrisma();
    if (createdIds.length > 0) {
      await db.$executeRaw`DELETE FROM ledger_entry WHERE transaction_id = ANY(${createdIds}::uuid[])`;
      await db.$executeRaw`DELETE FROM ledger_transaction WHERE id = ANY(${createdIds}::uuid[])`;
    }
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
    await disconnectTestPrisma();
  }
}, 120_000);

describe('TASK-167 rendimiento del API con el seed de 5.000 movimientos', () => {
  it('RNF-03 el seed deja 5.000 movimientos en el usuario de rendimiento', async () => {
    const rows = await testPrisma().$queryRaw<{ n: number }[]>`
      SELECT count(*)::int AS n FROM ledger_transaction
       WHERE user_id = ${userId}::uuid AND deleted_at IS NULL`;
    expect(rows[0]?.n).toBeGreaterThanOrEqual(SEEDED_TRANSACTIONS);
  });

  it(
    'RNF-03 el p95 de GET /api/dashboard es menor que 1,2 s',
    async () => {
      const month = todayInLaPaz().slice(0, 7);
      const warm = await homeOf(month);
      expect(warm.status).toBe(200);

      const times: number[] = [];
      for (let i = 0; i < HOME_SAMPLES; i += 1) {
        const { status, ms } = await timed(() => homeOf(month));
        expect(status).toBe(200);
        times.push(ms);
      }

      const body = warm.body as DashboardViewDto;
      expect(body.range.currentMonth).toBe(month);
      expect(times).toHaveLength(HOME_SAMPLES);
      expect(p95(times)).toBeLessThan(HOME_P95_LIMIT_MS);
    },
    HOME_SAMPLES * 5_000,
  );

  describe('EXPLAIN ANALYZE de las consultas del Inicio', () => {
    const today = todayInLaPaz();
    const month = today.slice(0, 7);
    const currentFrom = `${month}-01`;
    const previousFrom = new Date(
      Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5, 7)) - 2, 1),
    )
      .toISOString()
      .slice(0, 10);
    const previousTo = new Date(Date.parse(`${currentFrom}T00:00:00Z`) - 86_400_000)
      .toISOString()
      .slice(0, 10);

    /** Runs the query under EXPLAIN ANALYZE with sequential scans disabled and returns the plan. */
    async function planOf(
      run: (tx: TransactionClient) => Promise<{ 'QUERY PLAN': string }[]>,
    ): Promise<string> {
      return testPrisma().$transaction(async (tx) => {
        await tx.$executeRawUnsafe('SET LOCAL enable_seqscan = off');
        const rows = await run(tx);
        return rows.map((row) => row['QUERY PLAN']).join('\n');
      });
    }

    const queries: [string, (tx: TransactionClient) => Promise<{ 'QUERY PLAN': string }[]>][] = [
      [
        'los totales del mes y del mes anterior',
        (tx) => tx.$queryRaw`
          EXPLAIN (ANALYZE, FORMAT TEXT)
          WITH base AS (SELECT 'BOB'::char(3) AS code),
          counted AS (
            SELECT t.date, t.kind,
                   CASE WHEN a.currency_code = base.code THEN e.amount
                        ELSE round(e.amount * t.rate_cur_bob
                                   / CASE base.code WHEN 'BOB' THEN 1 WHEN 'USD' THEN t.rate_usd_bob
                                       ELSE user_rate_on(t.user_id, base.code, t.date) END, 2)
                   END AS amount
              FROM ledger_transaction t
              LEFT JOIN category c ON c.user_id = t.user_id AND c.id = t.category_id
              JOIN ledger_entry e ON e.user_id = t.user_id AND e.transaction_id = t.id
              JOIN account a ON a.user_id = e.user_id AND a.id = e.account_id
             CROSS JOIN base
             WHERE t.user_id = ${userId}::uuid
               AND t.deleted_at IS NULL
               AND t.kind IN ('expense', 'income')
               AND c.system_key IS DISTINCT FROM 'debts'
               AND ((t.date >= ${currentFrom}::date AND t.date <= ${today}::date)
                 OR (t.date >= ${previousFrom}::date AND t.date <= ${previousTo}::date))
          )
          SELECT COALESCE(SUM(amount) FILTER (WHERE kind = 'income'
                   AND date >= ${currentFrom}::date AND date <= ${today}::date), 0)::text,
                 COALESCE(-SUM(amount) FILTER (WHERE kind = 'expense'
                   AND date >= ${currentFrom}::date AND date <= ${today}::date), 0)::text,
                 COALESCE(SUM(amount) FILTER (WHERE kind = 'income'
                   AND date >= ${previousFrom}::date AND date <= ${previousTo}::date), 0)::text,
                 COALESCE(-SUM(amount) FILTER (WHERE kind = 'expense'
                   AND date >= ${previousFrom}::date AND date <= ${previousTo}::date), 0)::text
            FROM counted`,
      ],
      [
        'el primer mes del rango',
        (tx) => tx.$queryRaw`
          EXPLAIN (ANALYZE, FORMAT TEXT)
          SELECT to_char(LEAST(
                   (SELECT MIN(date) FROM ledger_transaction
                     WHERE user_id = ${userId}::uuid AND deleted_at IS NULL),
                   (SELECT MIN(initial_balance_date) FROM account
                     WHERE user_id = ${userId}::uuid)), 'YYYY-MM') AS month`,
      ],
      [
        'el gasto por día y categoría',
        (tx) => tx.$queryRaw`
          EXPLAIN (ANALYZE, FORMAT TEXT)
          WITH base AS (SELECT 'BOB'::char(3) AS code),
          spent AS (
            SELECT t.date,
                   COALESCE(c.parent_id, c.id) AS category_id,
                   -(CASE WHEN a.currency_code = base.code THEN e.amount
                          ELSE round(e.amount * t.rate_cur_bob
                                     / CASE base.code WHEN 'BOB' THEN 1 WHEN 'USD' THEN t.rate_usd_bob
                                         ELSE user_rate_on(t.user_id, base.code, t.date) END, 2)
                     END) AS amount
              FROM ledger_transaction t
              LEFT JOIN category c ON c.user_id = t.user_id AND c.id = t.category_id
              JOIN ledger_entry e ON e.user_id = t.user_id AND e.transaction_id = t.id
              JOIN account a ON a.user_id = e.user_id AND a.id = e.account_id
             CROSS JOIN base
             WHERE t.user_id = ${userId}::uuid
               AND t.deleted_at IS NULL
               AND t.kind = 'expense'
               AND c.system_key IS DISTINCT FROM 'debts'
               AND t.date >= ${previousFrom}::date AND t.date <= ${today}::date
          )
          SELECT to_char(s.date, 'YYYY-MM-DD') AS date, s.category_id::text, p.name,
                 COALESCE(SUM(s.amount), 0)::text
            FROM spent s
            LEFT JOIN category p ON p.user_id = ${userId}::uuid AND p.id = s.category_id
           GROUP BY s.date, s.category_id, p.name
           ORDER BY s.date`,
      ],
      [
        'los saldos de hoy de las cuentas',
        (tx) => tx.$queryRaw`
          EXPLAIN (ANALYZE, FORMAT TEXT)
          SELECT account.id::text,
                 (account.initial_balance + COALESCE(SUM(entry.amount), 0))::text
            FROM account
            LEFT JOIN (ledger_entry entry
                       JOIN ledger_transaction header
                         ON header.id = entry.transaction_id AND header.deleted_at IS NULL)
              ON entry.user_id = account.user_id
             AND entry.account_id = account.id
             AND entry.date >= account.initial_balance_date
           WHERE account.user_id = ${userId}::uuid
             AND account.id = ANY(ARRAY(SELECT id FROM account WHERE user_id = ${userId}::uuid))
           GROUP BY account.id, account.initial_balance`,
      ],
      [
        'los últimos movimientos',
        (tx) => tx.$queryRaw`
          EXPLAIN (ANALYZE, FORMAT TEXT)
          SELECT t.id, t.kind, t.date, t.note, t.category_id, t.created_at
            FROM ledger_transaction t
           WHERE t.user_id = ${userId}::uuid
             AND t.deleted_at IS NULL
             AND t.date >= ${previousFrom}::date
             AND t.date <= ${today}::date
           ORDER BY t.date DESC, t.created_at DESC, t.id DESC
           LIMIT 6`,
      ],
      [
        'las partidas de los últimos movimientos',
        (tx) => tx.$queryRaw`
          EXPLAIN (ANALYZE, FORMAT TEXT)
          SELECT e.transaction_id::text, e.account_id::text, a.currency_code::text, e.amount::text
            FROM ledger_entry e
            JOIN account a ON a.user_id = e.user_id AND a.id = e.account_id
           WHERE e.user_id = ${userId}::uuid
             AND e.transaction_id = ANY(ARRAY(
               SELECT t.id FROM ledger_transaction t
                WHERE t.user_id = ${userId}::uuid AND t.deleted_at IS NULL
                ORDER BY t.date DESC, t.created_at DESC, t.id DESC LIMIT 6))
           ORDER BY e.id ASC`,
      ],
      [
        'el neto de los días de los últimos movimientos',
        (tx) => tx.$queryRaw`
          EXPLAIN (ANALYZE, FORMAT TEXT)
          WITH base AS (SELECT 'BOB'::char(3) AS code)
          SELECT to_char(counted.date, 'YYYY-MM-DD'), COALESCE(SUM(counted.amount), 0)::text
            FROM (
              SELECT t.date, t.kind,
                     CASE WHEN a.currency_code = base.code THEN e.amount
                          ELSE round(e.amount * t.rate_cur_bob
                                     / CASE base.code WHEN 'BOB' THEN 1 WHEN 'USD' THEN t.rate_usd_bob
                                         ELSE user_rate_on(t.user_id, base.code, t.date) END, 2)
                     END AS amount
                FROM ledger_transaction t
                JOIN category c ON c.user_id = t.user_id AND c.id = t.category_id
                JOIN ledger_entry e ON e.user_id = t.user_id AND e.transaction_id = t.id
                JOIN account a ON a.user_id = e.user_id AND a.id = e.account_id
               CROSS JOIN base
               WHERE t.user_id = ${userId}::uuid
                 AND t.deleted_at IS NULL
                 AND t.date >= ${previousFrom}::date AND t.date <= ${today}::date
                 AND t.date = ANY(ARRAY[${today}, ${previousTo}]::date[])
                 AND t.kind IN ('expense', 'income')
                 AND c.system_key IS DISTINCT FROM 'debts'
            ) counted
           GROUP BY counted.date`,
      ],
    ];

    it.each(queries)(
      'RNF-03 %s no hace seq scan sobre ledger_transaction ni ledger_entry',
      async (_name, run) => {
        const plan = await planOf(run);

        expect(plan).toContain('Execution Time');
        expect(plan).not.toMatch(/Seq Scan on ledger_transaction/);
        expect(plan).not.toMatch(/Seq Scan on ledger_entry/);
      },
      60_000,
    );
  });

  it(
    'RNF-02 el p95 de POST /api/transactions es menor que 300 ms',
    async () => {
      const warmId = uuidv7();
      createdIds.push(warmId);
      expect((await saveExpense(warmId)).status).toBe(201);

      const times: number[] = [];
      for (let i = 0; i < SAVE_SAMPLES; i += 1) {
        const id = uuidv7();
        createdIds.push(id);
        const { status, ms } = await timed(() => saveExpense(id));
        expect(status).toBe(201);
        times.push(ms);
      }

      expect(times).toHaveLength(SAVE_SAMPLES);
      expect(p95(times)).toBeLessThan(SAVE_P95_LIMIT_MS);
    },
    SAVE_SAMPLES * 5_000,
  );

  it('RNF-02 los 200 movimientos guardados quedan en la base, una fila por cada id', async () => {
    const rows = await testPrisma().$queryRaw<{ n: number }[]>`
      SELECT count(*)::int AS n FROM ledger_transaction
       WHERE id = ANY(${createdIds}::uuid[]) AND user_id = ${userId}::uuid`;
    expect(createdIds.length).toBeGreaterThanOrEqual(SAVE_SAMPLES);
    expect(rows[0]?.n).toBe(createdIds.length);
  });
});
