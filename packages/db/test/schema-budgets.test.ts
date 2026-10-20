import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type pg from 'pg';
import { afterAll, describe, expect, it } from 'vitest';
import { closeSql, sql } from './helpers.js';

const CHECK_VIOLATION = '23514';
const UNIQUE_VIOLATION = '23505';

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

/** Inserts a valid auth_user with the system currencies BOB and USD and returns its id. */
async function insertUser(c: pg.PoolClient): Promise<string> {
  const id = randomUUID();
  await c.query(
    `INSERT INTO auth_user (id, name, email, terms_accepted_at, registered_at, timezone)
     VALUES ($1, 'Ana', $2, now(), now(), 'America/La_Paz')`,
    [id, `${id}@test.local`],
  );
  await c.query(
    `INSERT INTO currency (user_id, code, symbol, is_system, status)
     VALUES ($1, 'BOB', 'Bs', true, 'active'), ($1, 'USD', '$', true, 'active')`,
    [id],
  );
  return id;
}

async function insertCategory(c: pg.PoolClient, userId: string, name = 'Comida'): Promise<string> {
  const id = randomUUID();
  await c.query(
    `INSERT INTO category (id, user_id, kind, name, color, icon, sort_order)
     VALUES ($1, $2, 'expense', $3, '#22c55e', 'tag', 0)`,
    [id, userId, name],
  );
  return id;
}

interface BudgetInput {
  id?: string;
  scope?: 'category' | 'general';
  categoryId?: string | null;
  amount?: string;
  startDay?: number;
  nextStartDay?: number | null;
  thresholds?: string;
  status?: 'active' | 'paused' | 'finalizing' | 'finalized';
}

const INSERT_BUDGET = `INSERT INTO budget (id, user_id, scope, category_id, amount, currency_code,
                         start_day, next_start_day, thresholds, status)
                       VALUES ($1, $2, $3, $4, $5, 'BOB', $6, $7, $8::smallint[], $9)`;

function budgetValues(userId: string, a: BudgetInput): unknown[] {
  const scope = a.scope ?? 'general';
  return [
    a.id ?? randomUUID(),
    userId,
    scope,
    a.categoryId ?? null,
    a.amount ?? '1000.00',
    a.startDay ?? 1,
    a.nextStartDay ?? null,
    a.thresholds ?? '{80,100}',
    a.status ?? 'active',
  ];
}

function tryInsertBudget(
  c: pg.PoolClient,
  userId: string,
  a: BudgetInput = {},
): Promise<string | null> {
  return sqlState(c, INSERT_BUDGET, budgetValues(userId, a));
}

async function insertBudget(
  c: pg.PoolClient,
  userId: string,
  a: BudgetInput = {},
): Promise<string> {
  const id = a.id ?? randomUUID();
  await c.query(INSERT_BUDGET, budgetValues(userId, { ...a, id }));
  return id;
}

const INSERT_PERIOD = `INSERT INTO budget_period (id, user_id, budget_id, start_date, end_date, amount)
                       VALUES ($1, $2, $3, $4, $5, '1000.00')`;

async function insertPeriod(
  c: pg.PoolClient,
  userId: string,
  budgetId: string,
  startDate = '2026-03-01',
  endDate = '2026-03-31',
): Promise<string> {
  const id = randomUUID();
  await c.query(INSERT_PERIOD, [id, userId, budgetId, startDate, endDate]);
  return id;
}

const INSERT_HIT = `INSERT INTO budget_threshold_hit (period_id, threshold) VALUES ($1, $2)`;

describe('TASK-017 budget tables exist', () => {
  const tables = ['budget', 'budget_period', 'budget_late_adjustment', 'budget_threshold_hit'];

  it.each(tables)('TASK-017 the table %s exists', async (table) => {
    const { rows } = await sql().query<{ reg: string | null }>(
      `SELECT to_regclass('public.' || $1)::text AS reg`,
      [table],
    );
    expect(rows[0]!.reg).toBe(table);
  });

  it.each(tables)('TASK-017 schema.prisma declares a model mapped to %s', (table) => {
    const path = fileURLToPath(new URL('../prisma/schema.prisma', import.meta.url));
    const source = readFileSync(path, 'utf8');
    const models = [...source.matchAll(/^\s*model\s+\w+\s*\{([^}]*)\}/gm)];
    const re = new RegExp(`@@map\\(\\s*"${table}"\\s*\\)`);
    const mapped = models.filter(([, body]) => re.test(body!));
    expect(mapped).toHaveLength(1);
  });

  it('TASK-017 a budget_late_adjustment links a current period and a closed source period', async () => {
    await inTx(async (c) => {
      const userId = await insertUser(c);
      const budgetId = await insertBudget(c, userId);
      const source = await insertPeriod(c, userId, budgetId, '2026-02-01', '2026-02-28');
      const current = await insertPeriod(c, userId, budgetId, '2026-03-01', '2026-03-31');
      const state = await sqlState(
        c,
        `INSERT INTO budget_late_adjustment (id, user_id, period_id, source_period_id, amount)
         VALUES ($1, $2, $3, $4, '-25.50')`,
        [randomUUID(), userId, current, source],
      );
      expect(state).toBeNull();
    });
  });
});

describe('RF-M11-01 one active or paused budget per category, plus one general', () => {
  it('RF-M11-01 two active budgets of the same category are rejected', async () => {
    await inTx(async (c) => {
      const userId = await insertUser(c);
      const cat = await insertCategory(c, userId);
      await insertBudget(c, userId, { scope: 'category', categoryId: cat });
      expect(await tryInsertBudget(c, userId, { scope: 'category', categoryId: cat })).toBe(
        UNIQUE_VIOLATION,
      );
    });
  });

  it('RF-M11-01 an active and a paused budget of the same category cannot coexist', async () => {
    await inTx(async (c) => {
      const userId = await insertUser(c);
      const cat = await insertCategory(c, userId);
      await insertBudget(c, userId, { scope: 'category', categoryId: cat, status: 'paused' });
      expect(
        await tryInsertBudget(c, userId, { scope: 'category', categoryId: cat, status: 'active' }),
      ).toBe(UNIQUE_VIOLATION);
    });
  });

  it('RF-M11-01 two paused budgets of the same category cannot coexist', async () => {
    await inTx(async (c) => {
      const userId = await insertUser(c);
      const cat = await insertCategory(c, userId);
      await insertBudget(c, userId, { scope: 'category', categoryId: cat, status: 'paused' });
      expect(
        await tryInsertBudget(c, userId, { scope: 'category', categoryId: cat, status: 'paused' }),
      ).toBe(UNIQUE_VIOLATION);
    });
  });

  it('RF-M11-01 a finalizing budget of the category still blocks a new active one', async () => {
    await inTx(async (c) => {
      const userId = await insertUser(c);
      const cat = await insertCategory(c, userId);
      await insertBudget(c, userId, { scope: 'category', categoryId: cat, status: 'finalizing' });
      expect(await tryInsertBudget(c, userId, { scope: 'category', categoryId: cat })).toBe(
        UNIQUE_VIOLATION,
      );
    });
  });

  it('RF-M11-01 a finalized budget of the category does not count', async () => {
    await inTx(async (c) => {
      const userId = await insertUser(c);
      const cat = await insertCategory(c, userId);
      await insertBudget(c, userId, { scope: 'category', categoryId: cat, status: 'finalized' });
      await insertBudget(c, userId, { scope: 'category', categoryId: cat, status: 'finalized' });
      expect(await tryInsertBudget(c, userId, { scope: 'category', categoryId: cat })).toBeNull();
    });
  });

  it('RF-M11-01 different categories can each have an active budget', async () => {
    await inTx(async (c) => {
      const userId = await insertUser(c);
      const food = await insertCategory(c, userId, 'Comida');
      const transport = await insertCategory(c, userId, 'Transporte');
      await insertBudget(c, userId, { scope: 'category', categoryId: food });
      expect(
        await tryInsertBudget(c, userId, { scope: 'category', categoryId: transport }),
      ).toBeNull();
    });
  });

  it('RF-M11-01 two active general budgets are rejected', async () => {
    await inTx(async (c) => {
      const userId = await insertUser(c);
      await insertBudget(c, userId, { scope: 'general' });
      expect(await tryInsertBudget(c, userId, { scope: 'general' })).toBe(UNIQUE_VIOLATION);
    });
  });

  it('RF-M11-01 an active and a paused general budget cannot coexist', async () => {
    await inTx(async (c) => {
      const userId = await insertUser(c);
      await insertBudget(c, userId, { scope: 'general', status: 'paused' });
      expect(await tryInsertBudget(c, userId, { scope: 'general' })).toBe(UNIQUE_VIOLATION);
    });
  });

  it('RF-M11-01 a finalized general budget does not count', async () => {
    await inTx(async (c) => {
      const userId = await insertUser(c);
      await insertBudget(c, userId, { scope: 'general', status: 'finalized' });
      expect(await tryInsertBudget(c, userId, { scope: 'general' })).toBeNull();
    });
  });

  it('RF-M11-01 a general budget coexists with a category budget', async () => {
    await inTx(async (c) => {
      const userId = await insertUser(c);
      const cat = await insertCategory(c, userId);
      await insertBudget(c, userId, { scope: 'general' });
      expect(await tryInsertBudget(c, userId, { scope: 'category', categoryId: cat })).toBeNull();
    });
  });

  it('RF-M11-01 the uniqueness is per user: two users each have their own general budget', async () => {
    await inTx(async (c) => {
      const ana = await insertUser(c);
      const beto = await insertUser(c);
      await insertBudget(c, ana, { scope: 'general' });
      expect(await tryInsertBudget(c, beto, { scope: 'general' })).toBeNull();
    });
  });

  it('RF-M11-01 a general budget with a category, or a category budget without one, violates the CHECK', async () => {
    await inTx(async (c) => {
      const userId = await insertUser(c);
      const cat = await insertCategory(c, userId);
      expect(await tryInsertBudget(c, userId, { scope: 'general', categoryId: cat })).toBe(
        CHECK_VIOLATION,
      );
      expect(await tryInsertBudget(c, userId, { scope: 'category', categoryId: null })).toBe(
        CHECK_VIOLATION,
      );
    });
  });
});

describe('RF-M11-04 the period start day goes from 1 to 28', () => {
  it.each([0, 29, 31, -1])('RF-M11-04 start_day %i violates the CHECK', async (day) => {
    await inTx(async (c) => {
      const userId = await insertUser(c);
      expect(await tryInsertBudget(c, userId, { startDay: day })).toBe(CHECK_VIOLATION);
    });
  });

  it.each([1, 15, 28])('RF-M11-04 start_day %i is accepted', async (day) => {
    await inTx(async (c) => {
      const userId = await insertUser(c);
      expect(await tryInsertBudget(c, userId, { startDay: day })).toBeNull();
    });
  });

  it.each([0, 29])('RF-M11-04 next_start_day %i violates the CHECK', async (day) => {
    await inTx(async (c) => {
      const userId = await insertUser(c);
      expect(await tryInsertBudget(c, userId, { nextStartDay: day })).toBe(CHECK_VIOLATION);
    });
  });
});

describe('RF-M11-13 from 0 to 3 thresholds, each between 1 and 150', () => {
  it('RF-M11-13 four thresholds violate the CHECK', async () => {
    await inTx(async (c) => {
      const userId = await insertUser(c);
      expect(await tryInsertBudget(c, userId, { thresholds: '{50,80,100,120}' })).toBe(
        CHECK_VIOLATION,
      );
    });
  });

  it.each(['{0}', '{151}', '{80,0}', '{50,100,200}'])(
    'RF-M11-13 thresholds %s out of 1-150 violate the CHECK',
    async (thresholds) => {
      await inTx(async (c) => {
        const userId = await insertUser(c);
        expect(await tryInsertBudget(c, userId, { thresholds })).toBe(CHECK_VIOLATION);
      });
    },
  );

  it.each(['{}', '{1}', '{150}', '{50,80,100}', '{1,100,150}'])(
    'RF-M11-13 thresholds %s are accepted',
    async (thresholds) => {
      await inTx(async (c) => {
        const userId = await insertUser(c);
        expect(await tryInsertBudget(c, userId, { thresholds })).toBeNull();
      });
    },
  );

  it('RF-M11-13 thresholds default to {80,100}', async () => {
    await inTx(async (c) => {
      const userId = await insertUser(c);
      const id = randomUUID();
      await c.query(
        `INSERT INTO budget (id, user_id, scope, amount, currency_code, start_day)
         VALUES ($1, $2, 'general', '500.00', 'BOB', 1)`,
        [id, userId],
      );
      const { rows } = await c.query<{ t: string }>(
        `SELECT thresholds::text AS t FROM budget WHERE id = $1`,
        [id],
      );
      expect(rows[0]!.t).toBe('{80,100}');
    });
  });
});

describe('RNF-12 one notice per event, one decision per budget and period', () => {
  it('RNF-12 the same threshold cannot be registered twice for one period', async () => {
    await inTx(async (c) => {
      const userId = await insertUser(c);
      const budgetId = await insertBudget(c, userId);
      const period = await insertPeriod(c, userId, budgetId);
      expect(await sqlState(c, INSERT_HIT, [period, 80])).toBeNull();
      expect(await sqlState(c, INSERT_HIT, [period, 80])).toBe(UNIQUE_VIOLATION);
    });
  });

  it('RNF-12 different thresholds of one period are each registered once', async () => {
    await inTx(async (c) => {
      const userId = await insertUser(c);
      const budgetId = await insertBudget(c, userId);
      const period = await insertPeriod(c, userId, budgetId);
      expect(await sqlState(c, INSERT_HIT, [period, 80])).toBeNull();
      expect(await sqlState(c, INSERT_HIT, [period, 100])).toBeNull();
    });
  });

  it('RNF-12 the same threshold can be registered again in a different period', async () => {
    await inTx(async (c) => {
      const userId = await insertUser(c);
      const budgetId = await insertBudget(c, userId);
      const march = await insertPeriod(c, userId, budgetId, '2026-03-01', '2026-03-31');
      const april = await insertPeriod(c, userId, budgetId, '2026-04-01', '2026-04-30');
      expect(await sqlState(c, INSERT_HIT, [march, 80])).toBeNull();
      expect(await sqlState(c, INSERT_HIT, [april, 80])).toBeNull();
    });
  });

  it('RNF-12 a budget cannot have two periods with the same start date', async () => {
    await inTx(async (c) => {
      const userId = await insertUser(c);
      const budgetId = await insertBudget(c, userId);
      await insertPeriod(c, userId, budgetId, '2026-03-01', '2026-03-31');
      expect(
        await sqlState(c, INSERT_PERIOD, [
          randomUUID(),
          userId,
          budgetId,
          '2026-03-01',
          '2026-03-31',
        ]),
      ).toBe(UNIQUE_VIOLATION);
    });
  });
});
