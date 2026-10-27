import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closeSql, sql } from './helpers.js';

/**
 * TASK-166: the `seed:e2e` script of @finanzas/db is run as a command, against the test database,
 * exactly as qa-e2e.yml does. The seed users are the ones that did not exist before the first run.
 */

const PACKAGE_DIR = fileURLToPath(new URL('..', import.meta.url));
const RUN_TIMEOUT_MS = 180_000;
const PERF_TRANSACTIONS = 5000;

const COUNTED_TABLES = [
  'auth_user',
  'currency',
  'user_settings',
  'account',
  'category',
  'ledger_transaction',
  'ledger_entry',
  'market_rate',
  'favorite_category',
  'shortcut',
  'auth_account',
] as const;

function runSeed(): void {
  const url = process.env['TEST_DATABASE_URL'];
  if (!url) {
    throw new Error('TEST_DATABASE_URL is not set');
  }
  const result = spawnSync('pnpm', ['run', 'seed:e2e'], {
    cwd: PACKAGE_DIR,
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

async function userIds(): Promise<string[]> {
  const { rows } = await sql().query<{ id: string }>('SELECT id::text AS id FROM auth_user');
  return rows.map((r) => r.id);
}

async function marketRateKeys(): Promise<string[]> {
  const { rows } = await sql().query<{ key: string }>(
    `SELECT kind::text || '|' || to_char(rate_date, 'YYYY-MM-DD') AS key FROM market_rate`,
  );
  return rows.map((r) => r.key);
}

async function counts(): Promise<Record<string, number>> {
  const out: Record<string, number> = {};
  for (const table of COUNTED_TABLES) {
    const { rows } = await sql().query<{ n: string }>(`SELECT count(*)::text AS n FROM ${table}`);
    out[table] = Number(rows[0]?.n);
  }
  return out;
}

async function scalar(query: string, params: unknown[]): Promise<number> {
  const { rows } = await sql().query<{ n: string }>(query, params);
  return Number(rows[0]?.n);
}

async function perfUserIds(ids: string[]): Promise<string[]> {
  const { rows } = await sql().query<{ user_id: string }>(
    `SELECT user_id::text AS user_id FROM ledger_transaction
      WHERE user_id = ANY($1::uuid[]) GROUP BY user_id HAVING count(*) = $2`,
    [ids, PERF_TRANSACTIONS],
  );
  return rows.map((r) => r.user_id);
}

/** Content of everything the seed wrote, without clock-dependent columns. */
async function fingerprint(ids: string[], rateKeys: string[]): Promise<Record<string, string>> {
  const one = async (query: string, params: unknown[]): Promise<string> => {
    const { rows } = await sql().query<{ h: string | null }>(query, params);
    return rows[0]?.h ?? '';
  };
  return {
    users: await one(
      `SELECT md5(coalesce(string_agg(id::text || '|' || email, ',' ORDER BY id), '')) AS h
         FROM auth_user WHERE id = ANY($1::uuid[])`,
      [ids],
    ),
    accounts: await one(
      `SELECT md5(coalesce(string_agg(id::text || '|' || user_id::text || '|' || name || '|' ||
                currency_code || '|' || initial_balance::text, ',' ORDER BY id), '')) AS h
         FROM account WHERE user_id = ANY($1::uuid[])`,
      [ids],
    ),
    categories: await one(
      `SELECT md5(coalesce(string_agg(id::text || '|' || user_id::text || '|' || name || '|' || kind::text,
                ',' ORDER BY id), '')) AS h
         FROM category WHERE user_id = ANY($1::uuid[])`,
      [ids],
    ),
    transactions: await one(
      `SELECT md5(coalesce(string_agg(id::text || '|' || user_id::text || '|' || kind::text || '|' ||
                date::text || '|' || coalesce(category_id::text, '') || '|' || rate_cur_bob::text || '|' ||
                coalesce(rate_usd_bob::text, '') || '|' || coalesce(note, ''), ',' ORDER BY id), '')) AS h
         FROM ledger_transaction WHERE user_id = ANY($1::uuid[])`,
      [ids],
    ),
    entries: await one(
      `SELECT md5(coalesce(string_agg(id::text || '|' || transaction_id::text || '|' ||
                account_id::text || '|' || amount::text || '|' || date::text, ',' ORDER BY id), '')) AS h
         FROM ledger_entry WHERE user_id = ANY($1::uuid[])`,
      [ids],
    ),
    rates: await one(
      `SELECT md5(coalesce(string_agg(kind::text || '|' || to_char(rate_date, 'YYYY-MM-DD') || '|' ||
                value::text, ',' ORDER BY kind::text, rate_date), '')) AS h
         FROM market_rate WHERE kind::text || '|' || to_char(rate_date, 'YYYY-MM-DD') = ANY($1::text[])`,
      [rateKeys],
    ),
  };
}

async function removeUsers(ids: string[]): Promise<void> {
  if (ids.length === 0) {
    return;
  }
  const db = sql();
  await db.query('DELETE FROM ledger_transaction WHERE user_id = ANY($1::uuid[])', [ids]);
  await db.query('DELETE FROM category WHERE user_id = ANY($1::uuid[]) AND parent_id IS NOT NULL', [ids]);
  await db.query('DELETE FROM auth_user WHERE id = ANY($1::uuid[])', [ids]);
}

let usersBefore: string[] = [];
let ratesBefore: string[] = [];
let seedUsers: string[] = [];
let seedRates: string[] = [];
let afterFirst: Record<string, number> = {};
let afterSecond: Record<string, number> = {};
let fingerprintFirst: Record<string, string> = {};
let fingerprintSecond: Record<string, string> = {};

beforeAll(async () => {
  usersBefore = await userIds();
  ratesBefore = await marketRateKeys();

  runSeed();
  const knownUsers = new Set(usersBefore);
  const knownRates = new Set(ratesBefore);
  seedUsers = (await userIds()).filter((id) => !knownUsers.has(id));
  seedRates = (await marketRateKeys()).filter((key) => !knownRates.has(key));
  afterFirst = await counts();
  fingerprintFirst = await fingerprint(seedUsers, seedRates);

  runSeed();
  afterSecond = await counts();
  fingerprintSecond = await fingerprint(seedUsers, seedRates);
}, RUN_TIMEOUT_MS * 2 + 60_000);

afterAll(async () => {
  try {
    const knownUsers = new Set(usersBefore);
    const knownRates = new Set(ratesBefore);
    await removeUsers((await userIds()).filter((id) => !knownUsers.has(id)));
    const extra = (await marketRateKeys()).filter((key) => !knownRates.has(key));
    if (extra.length > 0) {
      await sql().query(
        `DELETE FROM market_rate WHERE kind::text || '|' || to_char(rate_date, 'YYYY-MM-DD') = ANY($1::text[])`,
        [extra],
      );
    }
  } finally {
    await closeSql();
  }
}, 120_000);

describe('TASK-166 seed:e2e known users and fixed rates', () => {
  it('TASK-166 creates known test users, more than one', () => {
    expect(seedUsers.length).toBeGreaterThanOrEqual(2);
  });

  it('TASK-166 market_rate has fixed rates for 13 months', async () => {
    const { rows } = await sql().query<{ months: string; positive: boolean }>(
      `SELECT count(DISTINCT to_char(rate_date, 'YYYY-MM'))::text AS months, bool_and(value > 0) AS positive
         FROM market_rate WHERE kind::text || '|' || to_char(rate_date, 'YYYY-MM-DD') = ANY($1::text[])`,
      [seedRates],
    );
    expect(seedRates.length).toBeGreaterThan(0);
    expect(Number(rows[0]?.months)).toBeGreaterThanOrEqual(13);
    expect(rows[0]?.positive).toBe(true);
  });
});

describe('TASK-166 seed:e2e performance user', () => {
  it('RNF-03 el usuario de rendimiento tiene exactamente 5.000 transacciones', async () => {
    const perf = await perfUserIds(seedUsers);
    expect(perf).toHaveLength(1);
    const total = await scalar('SELECT count(*)::text AS n FROM ledger_transaction WHERE user_id = $1::uuid', [
      perf[0],
    ]);
    const live = await scalar(
      'SELECT count(*)::text AS n FROM ledger_transaction WHERE user_id = $1::uuid AND deleted_at IS NULL',
      [perf[0]],
    );
    expect(total).toBe(PERF_TRANSACTIONS);
    expect(live).toBe(PERF_TRANSACTIONS);
  });

  it('RNF-03 los 5.000 movimientos se reparten en 12 meses consecutivos', async () => {
    const [perf] = await perfUserIds(seedUsers);
    const { rows } = await sql().query<{ months: string; span: string }>(
      `SELECT count(DISTINCT to_char(date, 'YYYY-MM'))::text AS months,
              (max(extract(year FROM date) * 12 + extract(month FROM date)) -
               min(extract(year FROM date) * 12 + extract(month FROM date)))::text AS span
         FROM ledger_transaction WHERE user_id = $1::uuid`,
      [perf],
    );
    expect(Number(rows[0]?.months)).toBe(12);
    expect(Number(rows[0]?.span)).toBe(11);
  });

  it('RNF-03 los movimientos usan varias cuentas y varias categorías', async () => {
    const [perf] = await perfUserIds(seedUsers);
    const accounts = await scalar(
      'SELECT count(DISTINCT account_id)::text AS n FROM ledger_entry WHERE user_id = $1::uuid',
      [perf],
    );
    const categories = await scalar(
      'SELECT count(DISTINCT category_id)::text AS n FROM ledger_transaction WHERE user_id = $1::uuid',
      [perf],
    );
    expect(accounts).toBeGreaterThanOrEqual(3);
    expect(categories).toBeGreaterThanOrEqual(3);
  });

  it('RNF-03 cada movimiento del usuario de rendimiento tiene sus asientos', async () => {
    const [perf] = await perfUserIds(seedUsers);
    const orphans = await scalar(
      `SELECT count(*)::text AS n FROM ledger_transaction t
        WHERE t.user_id = $1::uuid AND NOT EXISTS (SELECT 1 FROM ledger_entry e WHERE e.transaction_id = t.id)`,
      [perf],
    );
    expect(orphans).toBe(0);
  });
});

describe('TASK-166 seed:e2e idempotent and deterministic', () => {
  it('TASK-166 correrlo dos veces no duplica nada', () => {
    expect(afterSecond).toEqual(afterFirst);
    expect(fingerprintSecond).toEqual(fingerprintFirst);
  });

  it('RNF-03 tras correrlo dos veces el usuario de rendimiento sigue con 5.000 transacciones', async () => {
    const perf = await perfUserIds(seedUsers);
    expect(perf).toHaveLength(1);
  });

  it(
    'TASK-166 es determinista: borrar los datos y correrlo de nuevo produce lo mismo',
    async () => {
      await removeUsers(seedUsers);
      if (seedRates.length > 0) {
        await sql().query(
          `DELETE FROM market_rate WHERE kind::text || '|' || to_char(rate_date, 'YYYY-MM-DD') = ANY($1::text[])`,
          [seedRates],
        );
      }
      runSeed();
      expect((await userIds()).filter((id) => seedUsers.includes(id)).sort()).toEqual([...seedUsers].sort());
      expect(await fingerprint(seedUsers, seedRates)).toEqual(fingerprintFirst);
    },
    RUN_TIMEOUT_MS + 60_000,
  );
});
