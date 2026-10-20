import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type pg from 'pg';
import { afterAll, describe, expect, it } from 'vitest';
import { closeSql, sql } from './helpers.js';

const CHECK_VIOLATION = '23514';
const UNIQUE_VIOLATION = '23505';
const FK_VIOLATION = '23503';
const STRING_TOO_LONG = '22001';

/** Tables of plan §3.4 created by TASK-013. */
const FX_SETTINGS_TABLES = [
  'market_rate',
  'currency',
  'user_fx_event',
  'user_settings',
  'favorite_category',
] as const;

afterAll(async () => {
  await closeSql();
});

/** Runs `fn` inside a transaction that is always rolled back. */
async function inTx(fn: (c: pg.PoolClient) => Promise<void>): Promise<void> {
  const client = await sql().connect();
  try {
    await client.query('BEGIN');
    await fn(client);
  } finally {
    await client.query('ROLLBACK');
    client.release();
  }
}

/** Runs a statement under a savepoint and returns the SQLSTATE it raised, or null if it succeeded. */
async function sqlState(
  c: pg.PoolClient,
  text: string,
  values: unknown[] = [],
): Promise<string | null> {
  await c.query('SAVEPOINT probe');
  try {
    await c.query(text, values);
    await c.query('RELEASE SAVEPOINT probe');
    return null;
  } catch (err) {
    await c.query('ROLLBACK TO SAVEPOINT probe');
    return (err as { code?: string }).code ?? 'unknown';
  }
}

/** Inserts a valid auth_user (optionally with a timezone) and returns its id. */
async function insertUser(c: pg.PoolClient, timezone = 'America/La_Paz'): Promise<string> {
  const id = randomUUID();
  await c.query(
    `INSERT INTO auth_user (id, name, email, terms_accepted_at, registered_at, timezone)
     VALUES ($1, 'Ana', $2, now(), now(), $3)`,
    [id, `${id}@test.local`, timezone],
  );
  return id;
}

const INSERT_CURRENCY = `INSERT INTO currency (user_id, code, symbol, is_system, status)
                         VALUES ($1, $2, $3, $4, $5)`;

async function insertCurrency(
  c: pg.PoolClient,
  userId: string,
  code: string,
  opts: { symbol?: string; isSystem?: boolean; status?: 'active' | 'inactive' } = {},
): Promise<void> {
  await c.query(INSERT_CURRENCY, [
    userId,
    code,
    opts.symbol ?? code.slice(0, 2),
    opts.isSystem ?? false,
    opts.status ?? 'active',
  ]);
}

/** Inserts a user with the system currencies BOB and USD plus an added EUR. */
async function userWithCurrencies(c: pg.PoolClient, timezone = 'America/La_Paz'): Promise<string> {
  const userId = await insertUser(c, timezone);
  await insertCurrency(c, userId, 'BOB', { symbol: 'Bs', isSystem: true });
  await insertCurrency(c, userId, 'USD', { symbol: '$', isSystem: true });
  await insertCurrency(c, userId, 'EUR', { symbol: '€' });
  return userId;
}

const INSERT_MARKET_RATE = `INSERT INTO market_rate (kind, rate_date, value, observed_at, source)
                            VALUES ($1, $2, $3, now(), $4)`;

const INSERT_FX_EVENT = `INSERT INTO user_fx_event (id, user_id, kind, currency_code, reference, value, effective_at)
                         VALUES ($1, $2, $3, $4, $5, $6, COALESCE($7::timestamptz, now()))`;

async function insertFxEvent(
  c: pg.PoolClient,
  userId: string,
  e: {
    kind: string;
    currency?: string | null;
    reference?: string | null;
    value?: string | null;
    at?: string | null;
  },
): Promise<string | null> {
  return sqlState(c, INSERT_FX_EVENT, [
    randomUUID(),
    userId,
    e.kind,
    e.currency ?? null,
    e.reference ?? null,
    e.value ?? null,
    e.at ?? null,
  ]);
}

async function rateOn(
  c: pg.PoolClient,
  userId: string,
  code: string,
  date: string,
): Promise<string | null> {
  const { rows } = await c.query<{ rate: string | null }>(
    `SELECT user_rate_on($1, $2, $3::date)::text AS rate`,
    [userId, code, date],
  );
  return rows[0]!.rate;
}

const INSERT_SETTINGS = `INSERT INTO user_settings (user_id, dashboard_blocks, base_currency, manual_usd_value, manual_usd_since)
                         VALUES ($1, '[]'::jsonb, $2, $3, $4)`;

describe('TASK-013 fx and settings tables exist', () => {
  it.each(FX_SETTINGS_TABLES)('TASK-013 the table %s exists', async (table) => {
    const { rows } = await sql().query<{ reg: string | null }>(
      `SELECT to_regclass($1)::text AS reg`,
      [`public.${table}`],
    );
    expect(rows[0]!.reg).toBe(table);
  });

  it.each(FX_SETTINGS_TABLES)('TASK-013 schema.prisma declares a model mapped to %s', (table) => {
    const path = fileURLToPath(new URL('../prisma/schema.prisma', import.meta.url));
    const source = readFileSync(path, 'utf8');
    const models = [...source.matchAll(/^\s*model\s+\w+\s*\{([^}]*)\}/gm)];
    const mapped = models.filter(([, body]) =>
      new RegExp(`@@map\\(\\s*"${table}"\\s*\\)`).test(body!),
    );
    expect(mapped).toHaveLength(1);
  });

  it('TASK-013 the function user_rate_on(uuid, char, date) exists', async () => {
    const { rows } = await sql().query<{ reg: string | null }>(
      `SELECT to_regprocedure('public.user_rate_on(uuid, character, date)')::text AS reg`,
    );
    expect(rows[0]!.reg).not.toBeNull();
  });

  it('TASK-013 market_rate is global and has no user_id column (ADR-12)', async () => {
    const { rows } = await sql().query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'market_rate' ORDER BY column_name`,
    );
    expect(rows.map((r) => r.column_name)).toEqual([
      'kind',
      'observed_at',
      'rate_date',
      'source',
      'value',
    ]);
  });

  it('TASK-013 market_rate keeps one rate per kind and day', async () => {
    await inTx(async (c) => {
      expect(
        await sqlState(c, INSERT_MARKET_RATE, ['parallel_bid', '2001-01-01', '6.96', 'seed']),
      ).toBeNull();
      expect(
        await sqlState(c, INSERT_MARKET_RATE, ['parallel_bid', '2001-01-01', '7.00', 'seed']),
      ).toBe(UNIQUE_VIOLATION);
      expect(
        await sqlState(c, INSERT_MARKET_RATE, ['parallel_ask', '2001-01-01', '7.00', 'seed']),
      ).toBeNull();
    });
  });
});

describe('RF-M3-01 system currencies stay active and amounts use 2 decimals', () => {
  it('RF-M3-01 a system currency cannot be inserted as inactive', async () => {
    await inTx(async (c) => {
      const userId = await insertUser(c);
      expect(await sqlState(c, INSERT_CURRENCY, [userId, 'BOB', 'Bs', true, 'inactive'])).toBe(
        CHECK_VIOLATION,
      );
    });
  });

  it('RF-M3-01 a system currency cannot be updated to inactive', async () => {
    await inTx(async (c) => {
      const userId = await insertUser(c);
      await insertCurrency(c, userId, 'USD', { symbol: '$', isSystem: true });
      expect(
        await sqlState(
          c,
          `UPDATE currency SET status = 'inactive' WHERE user_id = $1 AND code = 'USD'`,
          [userId],
        ),
      ).toBe(CHECK_VIOLATION);
    });
  });

  it('RF-M3-01 an added (non-system) currency can be inactive', async () => {
    await inTx(async (c) => {
      const userId = await insertUser(c);
      expect(
        await sqlState(c, INSERT_CURRENCY, [userId, 'EUR', '€', false, 'inactive']),
      ).toBeNull();
    });
  });

  it('RF-M3-01 a new currency is active by default', async () => {
    await inTx(async (c) => {
      const userId = await insertUser(c);
      await c.query(`INSERT INTO currency (user_id, code, symbol) VALUES ($1, 'EUR', '€')`, [
        userId,
      ]);
      const { rows } = await c.query<{ status: string; is_system: boolean }>(
        `SELECT status::text AS status, is_system FROM currency WHERE user_id = $1 AND code = 'EUR'`,
        [userId],
      );
      expect(rows[0]).toEqual({ status: 'active', is_system: false });
    });
  });

  it.each([
    ['market_rate', 'value'],
    ['user_fx_event', 'value'],
    ['user_settings', 'manual_usd_value'],
  ])('RF-M3-01 the rate column %s.%s is numeric(14,2)', async (table, column) => {
    const { rows } = await sql().query<{
      data_type: string;
      numeric_precision: number;
      numeric_scale: number;
    }>(
      `SELECT data_type, numeric_precision, numeric_scale FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = $1 AND column_name = $2`,
      [table, column],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toEqual({ data_type: 'numeric', numeric_precision: 14, numeric_scale: 2 });
  });
});

describe('RF-M3-02 currency code and minimum rate', () => {
  it('RF-M3-02 a market rate below 0.01 violates the CHECK', async () => {
    await inTx(async (c) => {
      expect(await sqlState(c, INSERT_MARKET_RATE, ['official', '2001-01-02', '0.00', 'bcb'])).toBe(
        CHECK_VIOLATION,
      );
      expect(
        await sqlState(c, INSERT_MARKET_RATE, ['official', '2001-01-03', '-1.00', 'bcb']),
      ).toBe(CHECK_VIOLATION);
    });
  });

  it('RF-M3-02 a market rate of exactly 0.01 is accepted', async () => {
    await inTx(async (c) => {
      expect(
        await sqlState(c, INSERT_MARKET_RATE, ['official', '2001-01-04', '0.01', 'bcb']),
      ).toBeNull();
    });
  });

  it('RF-M3-02 a custom rate below 0.01 violates the CHECK', async () => {
    await inTx(async (c) => {
      const userId = await userWithCurrencies(c);
      expect(
        await insertFxEvent(c, userId, { kind: 'custom_rate', currency: 'EUR', value: '0.00' }),
      ).toBe(CHECK_VIOLATION);
      expect(
        await insertFxEvent(c, userId, { kind: 'custom_rate', currency: 'EUR', value: '-2.50' }),
      ).toBe(CHECK_VIOLATION);
    });
  });

  it('RF-M3-02 a custom rate of exactly 0.01 is accepted', async () => {
    await inTx(async (c) => {
      const userId = await userWithCurrencies(c);
      expect(
        await insertFxEvent(c, userId, { kind: 'custom_rate', currency: 'EUR', value: '0.01' }),
      ).toBeNull();
    });
  });

  it('RF-M3-02 a manual USD value below 0.01 violates the CHECK', async () => {
    await inTx(async (c) => {
      const userId = await userWithCurrencies(c);
      expect(
        await insertFxEvent(c, userId, { kind: 'manual_usd_on', currency: 'USD', value: '0.00' }),
      ).toBe(CHECK_VIOLATION);
      expect(
        await sqlState(c, INSERT_SETTINGS, [userId, 'BOB', '0.00', new Date().toISOString()]),
      ).toBe(CHECK_VIOLATION);
    });
  });

  it.each(['usd', 'U1D', 'AB', 'E R'])(
    'RF-M3-02 the currency code %j violates the CHECK',
    async (code) => {
      await inTx(async (c) => {
        const userId = await insertUser(c);
        expect(await sqlState(c, INSERT_CURRENCY, [userId, code, 'X', false, 'active'])).toBe(
          CHECK_VIOLATION,
        );
      });
    },
  );

  it('RF-M3-02 a code longer than 3 letters is rejected', async () => {
    await inTx(async (c) => {
      const userId = await insertUser(c);
      expect(await sqlState(c, INSERT_CURRENCY, [userId, 'EURO', 'X', false, 'active'])).toBe(
        STRING_TOO_LONG,
      );
    });
  });

  it('RF-M3-02 the currency code is unique for the user', async () => {
    await inTx(async (c) => {
      const userId = await insertUser(c);
      expect(await sqlState(c, INSERT_CURRENCY, [userId, 'EUR', '€', false, 'active'])).toBeNull();
      expect(await sqlState(c, INSERT_CURRENCY, [userId, 'EUR', 'E', false, 'inactive'])).toBe(
        UNIQUE_VIOLATION,
      );
    });
  });

  it('RF-M3-02 two users can each have the same currency code', async () => {
    await inTx(async (c) => {
      const a = await insertUser(c);
      const b = await insertUser(c);
      expect(await sqlState(c, INSERT_CURRENCY, [a, 'EUR', '€', false, 'active'])).toBeNull();
      expect(await sqlState(c, INSERT_CURRENCY, [b, 'EUR', '€', false, 'active'])).toBeNull();
    });
  });

  it.each([
    ['', CHECK_VIOLATION],
    ['   ', CHECK_VIOLATION],
    ['ABCDEF', STRING_TOO_LONG],
  ])('TASK-013 the currency symbol %j is rejected', async (symbol, state) => {
    await inTx(async (c) => {
      const userId = await insertUser(c);
      expect(await sqlState(c, INSERT_CURRENCY, [userId, 'EUR', symbol, false, 'active'])).toBe(
        state,
      );
    });
  });
});

describe('TASK-013 user_fx_event CHECK by kind', () => {
  it.each([
    ['reference_set without reference', { kind: 'reference_set' }],
    ['reference_set with a value', { kind: 'reference_set', reference: 'official', value: '6.96' }],
    ['manual_usd_on without value', { kind: 'manual_usd_on', currency: 'USD' }],
    [
      'manual_usd_on for a currency other than USD',
      { kind: 'manual_usd_on', currency: 'EUR', value: '7.50' },
    ],
    ['manual_usd_off with a value', { kind: 'manual_usd_off', currency: 'USD', value: '7.50' }],
    ['manual_usd_off for a currency other than USD', { kind: 'manual_usd_off', currency: 'EUR' }],
    ['custom_rate without currency', { kind: 'custom_rate', value: '7.50' }],
    ['custom_rate without value', { kind: 'custom_rate', currency: 'EUR' }],
  ] as const)('TASK-013 %s violates the CHECK', async (_label, event) => {
    await inTx(async (c) => {
      const userId = await userWithCurrencies(c);
      expect(await insertFxEvent(c, userId, event)).toBe(CHECK_VIOLATION);
    });
  });

  it.each([
    ['reference_set with a reference', { kind: 'reference_set', reference: 'parallel_median' }],
    [
      'manual_usd_on for USD with a value',
      { kind: 'manual_usd_on', currency: 'USD', value: '7.50' },
    ],
    ['manual_usd_off for USD without value', { kind: 'manual_usd_off', currency: 'USD' }],
    [
      'custom_rate with currency and value',
      { kind: 'custom_rate', currency: 'EUR', value: '8.10' },
    ],
  ] as const)('TASK-013 %s is accepted', async (_label, event) => {
    await inTx(async (c) => {
      const userId = await userWithCurrencies(c);
      expect(await insertFxEvent(c, userId, event)).toBeNull();
    });
  });

  it('TASK-013 a custom rate for a currency the user does not have violates the foreign key', async () => {
    await inTx(async (c) => {
      const a = await userWithCurrencies(c);
      const b = await insertUser(c);
      await insertCurrency(c, b, 'GBP', { symbol: '£' });
      expect(
        await insertFxEvent(c, a, { kind: 'custom_rate', currency: 'GBP', value: '9.00' }),
      ).toBe(FK_VIOLATION);
    });
  });
});

describe('RF-M3-13 user_rate_on', () => {
  it('RF-M3-13 returns the last rate of the day in the user timezone', async () => {
    await inTx(async (c) => {
      const userId = await userWithCurrencies(c, 'America/La_Paz');
      await insertFxEvent(c, userId, {
        kind: 'custom_rate',
        currency: 'EUR',
        value: '7.50',
        at: '2026-03-10T10:00:00-04:00',
      });
      // 22:00 in La Paz is already 2026-03-11 in UTC, but it belongs to 2026-03-10 for the user.
      await insertFxEvent(c, userId, {
        kind: 'custom_rate',
        currency: 'EUR',
        value: '7.60',
        at: '2026-03-10T22:00:00-04:00',
      });
      await insertFxEvent(c, userId, {
        kind: 'custom_rate',
        currency: 'EUR',
        value: '7.70',
        at: '2026-03-12T12:00:00-04:00',
      });
      expect(await rateOn(c, userId, 'EUR', '2026-03-10')).toBe('7.60');
      expect(await rateOn(c, userId, 'EUR', '2026-03-12')).toBe('7.70');
    });
  });

  it('RF-M3-13 an event at local midnight belongs to the next day', async () => {
    await inTx(async (c) => {
      const userId = await userWithCurrencies(c, 'America/La_Paz');
      await insertFxEvent(c, userId, {
        kind: 'custom_rate',
        currency: 'EUR',
        value: '7.50',
        at: '2026-03-10T23:59:00-04:00',
      });
      await insertFxEvent(c, userId, {
        kind: 'custom_rate',
        currency: 'EUR',
        value: '7.90',
        at: '2026-03-11T00:00:00-04:00',
      });
      expect(await rateOn(c, userId, 'EUR', '2026-03-10')).toBe('7.50');
      expect(await rateOn(c, userId, 'EUR', '2026-03-11')).toBe('7.90');
    });
  });

  it('RF-M3-13 the day boundary follows each user timezone', async () => {
    await inTx(async (c) => {
      const laPaz = await userWithCurrencies(c, 'America/La_Paz');
      const tokyo = await userWithCurrencies(c, 'Asia/Tokyo');
      // 2026-03-10T20:00Z is 16:00 of 03-10 in La Paz and 05:00 of 03-11 in Tokyo.
      for (const u of [laPaz, tokyo]) {
        await insertFxEvent(c, u, {
          kind: 'custom_rate',
          currency: 'EUR',
          value: '7.00',
          at: '2026-03-01T12:00:00Z',
        });
        await insertFxEvent(c, u, {
          kind: 'custom_rate',
          currency: 'EUR',
          value: '8.00',
          at: '2026-03-10T20:00:00Z',
        });
      }
      expect(await rateOn(c, laPaz, 'EUR', '2026-03-10')).toBe('8.00');
      expect(await rateOn(c, tokyo, 'EUR', '2026-03-10')).toBe('7.00');
      expect(await rateOn(c, tokyo, 'EUR', '2026-03-11')).toBe('8.00');
    });
  });

  it('RF-M3-13 a day without data uses the closest previous day', async () => {
    await inTx(async (c) => {
      const userId = await userWithCurrencies(c);
      await insertFxEvent(c, userId, {
        kind: 'custom_rate',
        currency: 'EUR',
        value: '7.50',
        at: '2026-03-10T10:00:00-04:00',
      });
      await insertFxEvent(c, userId, {
        kind: 'custom_rate',
        currency: 'EUR',
        value: '7.60',
        at: '2026-03-12T10:00:00-04:00',
      });
      expect(await rateOn(c, userId, 'EUR', '2026-03-11')).toBe('7.50');
      expect(await rateOn(c, userId, 'EUR', '2026-04-30')).toBe('7.60');
    });
  });

  it('RF-M3-13 before the first data it returns the first known value', async () => {
    await inTx(async (c) => {
      const userId = await userWithCurrencies(c);
      await insertFxEvent(c, userId, {
        kind: 'custom_rate',
        currency: 'EUR',
        value: '7.50',
        at: '2026-03-10T10:00:00-04:00',
      });
      await insertFxEvent(c, userId, {
        kind: 'custom_rate',
        currency: 'EUR',
        value: '7.60',
        at: '2026-03-12T10:00:00-04:00',
      });
      expect(await rateOn(c, userId, 'EUR', '2026-03-09')).toBe('7.50');
      expect(await rateOn(c, userId, 'EUR', '2020-01-01')).toBe('7.50');
    });
  });

  it('RF-M3-13 returns null when the currency has no rate', async () => {
    await inTx(async (c) => {
      const userId = await userWithCurrencies(c);
      expect(await rateOn(c, userId, 'EUR', '2026-03-10')).toBeNull();
    });
  });

  it('RF-M3-13 only uses custom rates of the same user and currency', async () => {
    await inTx(async (c) => {
      const a = await userWithCurrencies(c);
      const b = await userWithCurrencies(c);
      await insertCurrency(c, a, 'GBP', { symbol: '£' });
      await insertFxEvent(c, a, {
        kind: 'custom_rate',
        currency: 'EUR',
        value: '7.50',
        at: '2026-03-10T10:00:00-04:00',
      });
      await insertFxEvent(c, a, {
        kind: 'custom_rate',
        currency: 'GBP',
        value: '9.00',
        at: '2026-03-10T11:00:00-04:00',
      });
      await insertFxEvent(c, a, {
        kind: 'manual_usd_on',
        currency: 'USD',
        value: '7.10',
        at: '2026-03-10T12:00:00-04:00',
      });
      await insertFxEvent(c, b, {
        kind: 'custom_rate',
        currency: 'EUR',
        value: '8.80',
        at: '2026-03-10T13:00:00-04:00',
      });
      expect(await rateOn(c, a, 'EUR', '2026-03-10')).toBe('7.50');
      expect(await rateOn(c, a, 'GBP', '2026-03-10')).toBe('9.00');
      expect(await rateOn(c, a, 'USD', '2026-03-10')).toBeNull();
      expect(await rateOn(c, b, 'EUR', '2026-03-10')).toBe('8.80');
    });
  });
});

describe('TASK-013 user_settings', () => {
  it('TASK-013 a settings row with BOB as base takes the plan defaults', async () => {
    await inTx(async (c) => {
      const userId = await userWithCurrencies(c);
      await c.query(
        `INSERT INTO user_settings (user_id, dashboard_blocks) VALUES ($1, '[]'::jsonb)`,
        [userId],
      );
      const { rows } = await c.query(
        `SELECT number_format::text, date_format::text, week_start::text, theme::text, sidebar_collapsed,
                base_currency, usd_reference::text, manual_usd_value, manual_usd_since, default_account_id,
                always_show_note, onboarding_step, onboarding_completed_at
           FROM user_settings WHERE user_id = $1`,
        [userId],
      );
      expect(rows[0]).toEqual({
        number_format: 'dot_comma',
        date_format: 'dmy',
        week_start: 'monday',
        theme: 'system',
        sidebar_collapsed: false,
        base_currency: 'BOB',
        usd_reference: 'parallel_median',
        manual_usd_value: null,
        manual_usd_since: null,
        default_account_id: null,
        always_show_note: false,
        onboarding_step: 1,
        onboarding_completed_at: null,
      });
    });
  });

  it('TASK-013 the base currency must be one of the user currencies', async () => {
    await inTx(async (c) => {
      const a = await userWithCurrencies(c);
      const b = await insertUser(c);
      await insertCurrency(c, b, 'GBP', { symbol: '£' });
      expect(await sqlState(c, INSERT_SETTINGS, [a, 'GBP', null, null])).toBe(FK_VIOLATION);
      expect(await sqlState(c, INSERT_SETTINGS, [a, 'EUR', null, null])).toBeNull();
    });
  });

  it('TASK-013 manual_usd_value and manual_usd_since are both set or both null', async () => {
    await inTx(async (c) => {
      const userId = await userWithCurrencies(c);
      const now = new Date().toISOString();
      expect(await sqlState(c, INSERT_SETTINGS, [userId, 'BOB', '7.50', null])).toBe(
        CHECK_VIOLATION,
      );
      expect(await sqlState(c, INSERT_SETTINGS, [userId, 'BOB', null, now])).toBe(CHECK_VIOLATION);
      expect(await sqlState(c, INSERT_SETTINGS, [userId, 'BOB', '7.50', now])).toBeNull();
    });
  });

  it.each([0, 4])('TASK-013 onboarding_step %i violates the CHECK', async (step) => {
    await inTx(async (c) => {
      const userId = await userWithCurrencies(c);
      expect(
        await sqlState(
          c,
          `INSERT INTO user_settings (user_id, dashboard_blocks, onboarding_step) VALUES ($1, '[]'::jsonb, $2)`,
          [userId, step],
        ),
      ).toBe(CHECK_VIOLATION);
    });
  });

  it('TASK-013 user_settings.updated_at is maintained by set_updated_at', async () => {
    const { rows } = await sql().query(
      `SELECT 1 FROM pg_trigger t JOIN pg_proc p ON p.oid = t.tgfoid
        WHERE t.tgrelid = 'public.user_settings'::regclass AND p.proname = 'set_updated_at' AND NOT t.tgisinternal`,
    );
    expect(rows).toHaveLength(1);
  });
});

describe('TASK-013 favorite_category', () => {
  it.each([0, 9])('TASK-013 position %i violates the CHECK', async (position) => {
    await inTx(async (c) => {
      const userId = await insertUser(c);
      expect(
        await sqlState(
          c,
          `INSERT INTO favorite_category (user_id, category_id, kind, position) VALUES ($1, $2, 'expense', $3)`,
          [userId, randomUUID(), position],
        ),
      ).toBe(CHECK_VIOLATION);
    });
  });

  it('TASK-013 (user_id, kind, position) is unique and deferrable initially deferred', async () => {
    const { rows } = await sql().query<{
      cols: string[];
      condeferrable: boolean;
      condeferred: boolean;
    }>(
      `SELECT array_agg(a.attname::text ORDER BY k.ord) AS cols, c.condeferrable, c.condeferred
         FROM pg_constraint c
         CROSS JOIN LATERAL unnest(c.conkey) WITH ORDINALITY AS k(attnum, ord)
         JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = k.attnum
        WHERE c.conrelid = 'public.favorite_category'::regclass AND c.contype = 'u'
        GROUP BY c.oid, c.condeferrable, c.condeferred`,
    );
    expect(rows).toContainEqual({
      cols: ['user_id', 'kind', 'position'],
      condeferrable: true,
      condeferred: true,
    });
  });
});

describe('TASK-013 cascade on account deletion', () => {
  it('TASK-013 deleting a user removes its currencies, fx events and settings', async () => {
    await inTx(async (c) => {
      const userId = await userWithCurrencies(c);
      await insertFxEvent(c, userId, { kind: 'custom_rate', currency: 'EUR', value: '7.50' });
      await c.query(INSERT_SETTINGS, [userId, 'BOB', null, null]);
      await c.query(`DELETE FROM auth_user WHERE id = $1`, [userId]);
      for (const table of ['currency', 'user_fx_event', 'user_settings']) {
        const r = await c.query(`SELECT 1 FROM ${table} WHERE user_id = $1`, [userId]);
        expect(r.rowCount).toBe(0);
      }
    });
  });
});
