import { createHash, scryptSync } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { DEFAULT_DASHBOARD_BLOCKS } from '@finanzas/contracts';
import { Decimal } from 'decimal.js';
import pg from 'pg';

import { PRESET_CATEGORIES, type PresetCategory } from './preset-categories.js';

/**
 * Seed of the end-to-end and performance suites (plan §1.5, §5.1; RNF-03).
 *
 * It creates known test users, fixed market rates for 13 months and, for the performance user,
 * 5.000 movements spread over 12 months. Every id derives from a stable name and every row is
 * inserted with `ON CONFLICT DO NOTHING`, so running it again changes nothing. The months are
 * anchored to the current day in La Paz.
 */

export const SEED_PASSWORD = 'Prueba-E2E-2026';

export interface SeedUser {
  key: string;
  name: string;
  email: string;
  /** The performance user is the only one with movements. */
  withMovements: boolean;
}

export const SEED_USERS: readonly SeedUser[] = [
  { key: 'a', name: 'Usuario E2E A', email: 'usuario-a@e2e.test', withMovements: false },
  { key: 'b', name: 'Usuario E2E B', email: 'usuario-b@e2e.test', withMovements: false },
  { key: 'perf', name: 'Usuario de rendimiento', email: 'rendimiento@e2e.test', withMovements: true },
];

export const PERF_TRANSACTIONS = 5000;

const PERF_MONTHS = 12;
const RATE_MONTHS = 13;
const LA_PAZ_OFFSET_HOURS = 4;
/** A rate is observed when its La Paz day starts, so any later capture can replace it. */
const START_OF_LA_PAZ_DAY = 'T04:00:00Z';
const FIXED_INSTANT = '2026-01-01T00:00:00Z';
const PASSWORD_SALT = 'e2e5eed0e2e5eed0e2e5eed0e2e5eed0';
const SCRYPT_COST = 16384;
const SCRYPT_BLOCK_SIZE = 16;
const RANDOM_SEED = 166;
const OFFICIAL_RATE = '6.96';
const FIRST_MEDIAN = '9.20';
const MONTHLY_STEP = '0.05';
const SPREAD = '0.10';

type Queryable = Pick<pg.Client, 'query'>;
type Column = readonly [name: string, type: string];
type Row = readonly unknown[];

// ---- Deterministic building blocks ----

/** A UUID derived from a name: same name, same id. Version and variant bits follow UUID v7. */
function stableUuid(name: string): string {
  const bytes = createHash('sha256').update(`finanzas-e2e:${name}`).digest().subarray(0, 16);
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x70;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return [hex.slice(0, 8), hex.slice(8, 12), hex.slice(12, 16), hex.slice(16, 20), hex.slice(20)].join(
    '-',
  );
}

/** Seeded generator (mulberry32) returning integers in `[0, bound)`. */
function createRandom(seed: number): (bound: number) => number {
  let state = seed >>> 0;
  return (bound) => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return Math.floor((((t ^ (t >>> 14)) >>> 0) / 4294967296) * bound);
  };
}

/** Same format as Better Auth (`salt:key`, scrypt, NFKC), with a fixed salt so the hash is stable. */
function hashPassword(password: string): string {
  const key = scryptSync(password.normalize('NFKC'), PASSWORD_SALT, 64, {
    N: SCRYPT_COST,
    r: SCRYPT_BLOCK_SIZE,
    p: 1,
    maxmem: 128 * SCRYPT_COST * SCRYPT_BLOCK_SIZE * 2,
  });
  return `${PASSWORD_SALT}:${key.toString('hex')}`;
}

function money(cents: number): string {
  return new Decimal(cents).div(100).toFixed(2);
}

const pad2 = (value: number): string => String(value).padStart(2, '0');

/** A month as a running number: `year * 12 + (month - 1)`. */
const monthLabel = (index: number): string => `${Math.floor(index / 12)}-${pad2((index % 12) + 1)}`;

const daysInMonth = (index: number): number =>
  new Date(Date.UTC(Math.floor(index / 12), (index % 12) + 1, 0)).getUTCDate();

interface Today {
  day: number;
  /** Running number of the current month. */
  month: number;
  iso: string;
}

function todayInLaPaz(now: Date): Today {
  const local = new Date(now.getTime() - LA_PAZ_OFFSET_HOURS * 3_600_000);
  return {
    day: local.getUTCDate(),
    month: local.getUTCFullYear() * 12 + local.getUTCMonth(),
    iso: local.toISOString().slice(0, 10),
  };
}

/** The parallel median is fixed per month and rises a little each month. */
function medianOf(rateMonthOffset: number): Decimal {
  return new Decimal(FIRST_MEDIAN).plus(new Decimal(MONTHLY_STEP).times(rateMonthOffset));
}

// ---- Bulk insert ----

/**
 * One statement per table: the columns travel as arrays and `unnest` turns them back into rows.
 * A deferrable unique constraint cannot arbitrate `ON CONFLICT`, so a table that has one names
 * the key to arbitrate with in `conflictTarget`.
 */
async function insertRows(
  db: Queryable,
  table: string,
  columns: readonly Column[],
  rows: readonly Row[],
  conflictTarget = '',
): Promise<void> {
  if (rows.length === 0) {
    return;
  }
  const names = columns.map(([name]) => name).join(', ');
  const arrays = columns.map(([, type], index) => `$${index + 1}::${type}[]`).join(', ');
  const params = columns.map((_, index) => rows.map((row) => row[index]));
  await db.query(
    `INSERT INTO ${table} (${names}) SELECT * FROM unnest(${arrays}) ON CONFLICT ${conflictTarget} DO NOTHING`,
    params,
  );
}

// ---- Market rates ----

async function seedMarketRates(db: Queryable, today: Today): Promise<void> {
  const firstMonth = today.month - (RATE_MONTHS - 1);
  const rows: Row[] = [];
  for (let month = firstMonth; month <= today.month; month += 1) {
    const median = medianOf(month - firstMonth);
    const lastDay = month === today.month ? today.day : daysInMonth(month);
    for (let day = 1; day <= lastDay; day += 1) {
      const date = `${monthLabel(month)}-${pad2(day)}`;
      const observedAt = `${date}${START_OF_LA_PAZ_DAY}`;
      rows.push(
        ['parallel_bid', date, median.minus(SPREAD).toFixed(2), observedAt, 'seed'],
        ['parallel_ask', date, median.plus(SPREAD).toFixed(2), observedAt, 'seed'],
        ['parallel_median', date, median.toFixed(2), observedAt, 'seed'],
        ['official', date, OFFICIAL_RATE, observedAt, 'seed'],
      );
    }
  }
  await insertRows(
    db,
    'market_rate',
    [
      ['kind', 'market_rate_kind'],
      ['rate_date', 'date'],
      ['value', 'numeric'],
      ['observed_at', 'timestamptz'],
      ['source', 'rate_source'],
    ],
    rows,
  );
}

// ---- Users ----

interface SeedCategory {
  id: string;
  kind: 'expense' | 'income';
  parentId: string | null;
  name: string;
  color: string;
  icon: string;
  systemKey: string | null;
  seedOrder: number;
  sortOrder: number;
  /** A category that can take movements: not a system one and without subcategories. */
  usable: boolean;
}

function flattenCategories(user: SeedUser): SeedCategory[] {
  const rows: SeedCategory[] = [];
  const add = (preset: PresetCategory, parent: SeedCategory | null): void => {
    const row: SeedCategory = {
      id: stableUuid(`category:${user.key}:${preset.kind}:${parent?.name ?? ''}:${preset.name}`),
      kind: preset.kind,
      parentId: parent?.id ?? null,
      name: preset.name,
      color: preset.color,
      icon: preset.icon,
      systemKey: preset.systemKey ?? null,
      seedOrder: preset.seedOrder,
      sortOrder: rows.length,
      usable: preset.systemKey === undefined && (preset.children ?? []).length === 0,
    };
    rows.push(row);
    for (const child of preset.children ?? []) {
      add(child, row);
    }
  };
  for (const preset of PRESET_CATEGORIES) {
    add(preset, null);
  }
  return rows;
}

interface SeedAccount {
  id: string;
  type: 'cash' | 'bank' | 'ewallet' | 'savings';
  name: string;
  currency: 'BOB' | 'USD';
  initialBalance: string;
  color: string;
  icon: string;
}

function accountsOf(user: SeedUser): SeedAccount[] {
  const definitions = [
    ['cash', 'Efectivo', 'BOB', '100000.00', 'green', 'wallet'],
    ['bank', 'Banco BNB', 'BOB', '200000.00', 'blue', 'landmark'],
    ['ewallet', 'Tigo Money', 'BOB', '100000.00', 'orange', 'smartphone'],
    ['savings', 'Ahorros USD', 'USD', '10000.00', 'teal', 'piggy-bank'],
  ] as const;
  return definitions.map(([type, name, currency, initialBalance, color, icon]) => ({
    id: stableUuid(`account:${user.key}:${type}`),
    type,
    name,
    currency,
    initialBalance,
    color,
    icon,
  }));
}

const NOTIFICATION_PREFERENCES = [
  ['payment_upcoming', true, null, null, null],
  ['budget_alert', true, null, null, null],
  ['period_close', true, null, null, null],
  ['recurring_pending', true, null, null, null],
  ['log_day', false, 21, null, [0, 1, 2, 3, 4, 5, 6]],
  ['goal_progress', false, null, null, null],
] as const;

const FAVORITES: readonly (readonly ['expense' | 'income', string])[] = [
  ['expense', 'Comida'],
  ['expense', 'Transporte'],
  ['expense', 'Servicios'],
  ['expense', 'Salud'],
  ['income', 'Sueldo'],
  ['income', 'Negocio/Ventas'],
];

interface SeededUser {
  user: SeedUser;
  id: string;
  accounts: SeedAccount[];
  categories: SeedCategory[];
}

async function seedUser(db: Queryable, user: SeedUser, firstDate: string): Promise<SeededUser> {
  const id = stableUuid(`user:${user.key}`);
  const accounts = accountsOf(user);
  const categories = flattenCategories(user);

  await db.query(
    `INSERT INTO auth_user (id, name, email, email_verified, terms_accepted_at, registered_at)
     VALUES ($1::uuid, $2, $3, true, $4::timestamptz, $4::timestamptz)
     ON CONFLICT DO NOTHING`,
    [id, user.name, user.email, FIXED_INSTANT],
  );
  await db.query(
    `INSERT INTO auth_account (id, user_id, account_id, provider_id, password)
     VALUES ($1::uuid, $2::uuid, $3, 'credential', $4)
     ON CONFLICT DO NOTHING`,
    [stableUuid(`auth-account:${user.key}`), id, id, hashPassword(SEED_PASSWORD)],
  );
  await db.query(
    `INSERT INTO currency (user_id, code, symbol, is_system, status)
     VALUES ($1::uuid, 'BOB', 'Bs', true, 'active'), ($1::uuid, 'USD', '$', true, 'active')
     ON CONFLICT DO NOTHING`,
    [id],
  );

  const categoryColumns: Column[] = [
    ['id', 'uuid'],
    ['user_id', 'uuid'],
    ['kind', 'category_kind'],
    ['parent_id', 'uuid'],
    ['name', 'text'],
    ['color', 'text'],
    ['icon', 'text'],
    ['is_system', 'boolean'],
    ['system_key', 'system_category_key'],
    ['seed_order', 'smallint'],
    ['sort_order', 'integer'],
  ];
  const categoryRow = (c: SeedCategory): Row => [
    c.id,
    id,
    c.kind,
    c.parentId,
    c.name,
    c.color,
    c.icon,
    c.systemKey !== null,
    c.systemKey,
    c.seedOrder,
    c.sortOrder,
  ];
  // The parents go first: the category guard looks them up when a subcategory is inserted.
  await insertRows(db, 'category', categoryColumns, categories.filter((c) => c.parentId === null).map(categoryRow));
  await insertRows(db, 'category', categoryColumns, categories.filter((c) => c.parentId !== null).map(categoryRow));

  await insertRows(
    db,
    'account',
    [
      ['id', 'uuid'],
      ['user_id', 'uuid'],
      ['type', 'account_type'],
      ['name', 'text'],
      ['currency_code', 'text'],
      ['initial_balance', 'numeric'],
      ['initial_balance_date', 'date'],
      ['color', 'text'],
      ['icon', 'text'],
      ['sort_order', 'integer'],
    ],
    accounts.map((a, index) => [
      a.id,
      id,
      a.type,
      a.name,
      a.currency,
      a.initialBalance,
      firstDate,
      a.color,
      a.icon,
      index,
    ]),
  );

  await db.query(
    `INSERT INTO user_settings
       (user_id, default_account_id, dashboard_blocks, onboarding_step, onboarding_completed_at)
     VALUES ($1::uuid, $2::uuid, $3::jsonb, 3, $4::timestamptz)
     ON CONFLICT DO NOTHING`,
    [id, accounts[0]?.id, JSON.stringify(DEFAULT_DASHBOARD_BLOCKS), FIXED_INSTANT],
  );

  const favorites: Row[] = [];
  const positions = { expense: 0, income: 0 };
  for (const [kind, name] of FAVORITES) {
    const category = categories.find((c) => c.kind === kind && c.parentId === null && c.name === name);
    if (category !== undefined) {
      positions[kind] += 1;
      favorites.push([id, category.id, kind, positions[kind]]);
    }
  }
  await insertRows(
    db,
    'favorite_category',
    [
      ['user_id', 'uuid'],
      ['category_id', 'uuid'],
      ['kind', 'category_kind'],
      ['position', 'smallint'],
    ],
    favorites,
    '(user_id, category_id)',
  );

  for (const [type, enabled, hour, leadDays, weekdays] of NOTIFICATION_PREFERENCES) {
    await db.query(
      `INSERT INTO notification_preference (user_id, type, enabled, hour, lead_days, weekdays)
       VALUES ($1::uuid, $2::notification_type, $3, $4, $5, COALESCE($6::smallint[], '{}'))
       ON CONFLICT DO NOTHING`,
      [id, type, enabled, hour, leadDays, weekdays],
    );
  }

  return { user, id, accounts, categories };
}

// ---- Movements of the performance user ----

async function seedMovements(db: Queryable, seeded: SeededUser, today: Today): Promise<void> {
  const random = createRandom(RANDOM_SEED);
  const firstMonth = today.month - (PERF_MONTHS - 1);
  const [cash, bank, ewallet, savings] = seeded.accounts;
  if (cash === undefined || bank === undefined || ewallet === undefined || savings === undefined) {
    throw new Error('The seed accounts are incomplete');
  }
  const bobAccounts = [cash, bank, ewallet];
  const expenseCategories = seeded.categories.filter((c) => c.usable && c.kind === 'expense');
  const incomeCategories = seeded.categories.filter((c) => c.usable && c.kind === 'income');
  const notes = ['Almuerzo', 'Pasaje', 'Compras del mes', 'Pago de servicio', 'Cobro', 'Salida'];

  const transactions: Row[] = [];
  const entries: Row[] = [];
  for (let index = 0; index < PERF_TRANSACTIONS; index += 1) {
    const month = firstMonth + Math.floor((index * PERF_MONTHS) / PERF_TRANSACTIONS);
    const lastDay = month === today.month ? Math.min(today.day, daysInMonth(month)) : daysInMonth(month);
    const date = `${monthLabel(month)}-${pad2(1 + random(lastDay))}`;
    const createdAt = new Date(`${date}T16:00:00Z`).getTime() + (index % 3600) * 1000;
    const median = medianOf(month - firstMonth + 1).toFixed(2);

    const kindDraw = random(100);
    const kind = kindDraw < 86 ? 'expense' : kindDraw < 94 ? 'income' : 'transfer';
    const accountDraw = random(100);
    const account =
      kind === 'transfer'
        ? (bobAccounts[random(bobAccounts.length)] ?? cash)
        : accountDraw < 35
          ? cash
          : accountDraw < 70
            ? bank
            : accountDraw < 90
              ? ewallet
              : savings;
    const target =
      kind === 'transfer'
        ? (bobAccounts.filter((a) => a.id !== account.id)[random(bobAccounts.length - 1)] ?? bank)
        : null;
    const pool = kind === 'expense' ? expenseCategories : incomeCategories;
    const category = kind === 'transfer' ? null : (pool[random(pool.length)] ?? null);
    const inUsd = account.currency === 'USD';
    const cents =
      kind === 'income'
        ? (inUsd ? 5000 : 30000) + random(inUsd ? 20000 : 120000)
        : kind === 'expense'
          ? 100 + random(inUsd ? 1900 : 7900)
          : 1000 + random(50000);
    const amount = money(cents);
    const note = index % 5 === 0 ? (notes[index % notes.length] ?? null) : null;
    const transactionId = stableUuid(`transaction:${seeded.user.key}:${index}`);

    transactions.push([
      transactionId,
      seeded.id,
      kind,
      date,
      note,
      category?.id ?? null,
      inUsd ? median : '1.00',
      median,
      new Date(createdAt).toISOString(),
    ]);
    entries.push([
      stableUuid(`entry:${transactionId}:0`),
      seeded.id,
      transactionId,
      account.id,
      kind === 'income' ? amount : `-${amount}`,
      date,
    ]);
    if (target !== null) {
      entries.push([
        stableUuid(`entry:${transactionId}:1`),
        seeded.id,
        transactionId,
        target.id,
        amount,
        date,
      ]);
    }
  }

  await insertRows(
    db,
    'ledger_transaction',
    [
      ['id', 'uuid'],
      ['user_id', 'uuid'],
      ['kind', 'transaction_kind'],
      ['date', 'date'],
      ['note', 'text'],
      ['category_id', 'uuid'],
      ['rate_cur_bob', 'numeric'],
      ['rate_usd_bob', 'numeric'],
      ['created_at', 'timestamptz'],
    ],
    transactions,
  );
  await insertRows(
    db,
    'ledger_entry',
    [
      ['id', 'uuid'],
      ['user_id', 'uuid'],
      ['transaction_id', 'uuid'],
      ['account_id', 'uuid'],
      ['amount', 'numeric'],
      ['date', 'date'],
    ],
    entries,
  );
}

// ---- Entry point ----

export async function runSeedE2e(db: Queryable, now: Date = new Date()): Promise<void> {
  const today = todayInLaPaz(now);
  const firstDate = `${monthLabel(today.month - (PERF_MONTHS - 1))}-01`;

  await seedMarketRates(db, today);
  for (const user of SEED_USERS) {
    const seeded = await seedUser(db, user, firstDate);
    if (user.withMovements) {
      await seedMovements(db, seeded, today);
    }
  }
}

async function main(): Promise<void> {
  if (process.env['NODE_ENV'] === 'production') {
    throw new Error('seed:e2e creates users with a known password and never runs in production');
  }
  const url = process.env['DATABASE_URL_DIRECT'] ?? process.env['DATABASE_URL'];
  if (!url) {
    throw new Error('DATABASE_URL is not set');
  }
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    await client.query('BEGIN');
    await runSeedE2e(client);
    await client.query('COMMIT');
    process.stdout.write(`seed:e2e done: ${SEED_USERS.length} users\n`);
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    await client.end();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
