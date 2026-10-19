import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type pg from 'pg';
import { afterAll, describe, expect, it } from 'vitest';
import { closeSql, sql } from './helpers.js';

const CHECK_VIOLATION = '23514';
const UNIQUE_VIOLATION = '23505';
const STRING_TOO_LONG = '22001';

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

async function insertAccount(c: pg.PoolClient, userId: string): Promise<string> {
  const id = randomUUID();
  await c.query(
    `INSERT INTO account (id, user_id, type, name, currency_code, initial_balance_date,
                          color, icon, sort_order)
     VALUES ($1, $2, 'bank', 'Banco', 'BOB', '2026-01-01', '#22c55e', 'wallet', 0)`,
    [id, userId],
  );
  return id;
}

async function insertCategory(c: pg.PoolClient, userId: string): Promise<string> {
  const id = randomUUID();
  await c.query(
    `INSERT INTO category (id, user_id, kind, name, color, icon, sort_order)
     VALUES ($1, $2, 'expense', 'Servicios', '#22c55e', 'tag', 0)`,
    [id, userId],
  );
  return id;
}

interface Fixture {
  userId: string;
  accountId: string;
  categoryId: string;
}

async function fixture(c: pg.PoolClient): Promise<Fixture> {
  const userId = await insertUser(c);
  const accountId = await insertAccount(c, userId);
  const categoryId = await insertCategory(c, userId);
  return { userId, accountId, categoryId };
}

interface RuleInput {
  id?: string;
  name?: string;
  amount?: string | null;
  mode?: 'auto' | 'confirm';
}

/** A monthly expense rule on day 5; only name, amount and mode vary. */
const INSERT_RULE = `INSERT INTO recurring_rule (id, user_id, name, kind, amount, account_id,
                       category_id, frequency, day_of_month, start_date, mode)
                     VALUES ($1, $2, $3, 'expense', $4, $5, $6, 'monthly', 5, '2026-01-05', $7)`;

function ruleValues(f: Fixture, a: RuleInput): unknown[] {
  return [
    a.id ?? randomUUID(),
    f.userId,
    a.name ?? 'Internet',
    a.amount === undefined ? '150.00' : a.amount,
    f.accountId,
    f.categoryId,
    a.mode ?? 'auto',
  ];
}

function tryInsertRule(c: pg.PoolClient, f: Fixture, a: RuleInput = {}): Promise<string | null> {
  return sqlState(c, INSERT_RULE, ruleValues(f, a));
}

async function insertRule(c: pg.PoolClient, f: Fixture, a: RuleInput = {}): Promise<string> {
  const id = a.id ?? randomUUID();
  await c.query(INSERT_RULE, ruleValues(f, { ...a, id }));
  return id;
}

const INSERT_OCCURRENCE = `INSERT INTO recurring_occurrence (id, user_id, rule_id, scheduled_date, status)
                           VALUES ($1, $2, $3, $4, $5)`;

function tryInsertOccurrence(
  c: pg.PoolClient,
  userId: string,
  ruleId: string,
  date: string,
  status: 'pending' | 'registered' | 'skipped' | 'omitted' = 'registered',
): Promise<string | null> {
  return sqlState(c, INSERT_OCCURRENCE, [randomUUID(), userId, ruleId, date, status]);
}

const INSERT_NOTIFICATION = `INSERT INTO notification (id, user_id, type, event_key, params, target_route)
                             VALUES ($1, $2, 'payment_upcoming', $3, '{}'::jsonb, '/deudas')`;

function tryInsertNotification(
  c: pg.PoolClient,
  userId: string,
  eventKey: string,
): Promise<string | null> {
  return sqlState(c, INSERT_NOTIFICATION, [randomUUID(), userId, eventKey]);
}

describe('TASK-019 recurring, notification and job_run tables exist', () => {
  const tables = [
    'recurring_rule',
    'recurring_occurrence',
    'notification',
    'notification_preference',
    'job_run',
  ];

  it.each(tables)('TASK-019 the table %s exists', async (table) => {
    const { rows } = await sql().query<{ reg: string | null }>(
      `SELECT to_regclass('public.' || $1)::text AS reg`,
      [table],
    );
    expect(rows[0]!.reg).toBe(table);
  });

  it.each(tables)('TASK-019 schema.prisma declares a model mapped to %s', (table) => {
    const path = fileURLToPath(new URL('../prisma/schema.prisma', import.meta.url));
    const source = readFileSync(path, 'utf8');
    const models = [...source.matchAll(/^\s*model\s+\w+\s*\{([^}]*)\}/gm)];
    const re = new RegExp(`@@map\\(\\s*"${table}"\\s*\\)`);
    const mapped = models.filter(([, body]) => re.test(body!));
    expect(mapped).toHaveLength(1);
  });
});

describe('RF-M14-12 at most one occurrence per rule and date', () => {
  it('RF-M14-12 two occurrences of the same rule and date violate the unique constraint', async () => {
    await inTx(async (c) => {
      const f = await fixture(c);
      const ruleId = await insertRule(c, f);
      expect(await tryInsertOccurrence(c, f.userId, ruleId, '2026-02-05')).toBeNull();
      expect(await tryInsertOccurrence(c, f.userId, ruleId, '2026-02-05', 'pending')).toBe(
        UNIQUE_VIOLATION,
      );
    });
  });

  it('RF-M14-12 the same rule on different dates and different rules on the same date are accepted', async () => {
    await inTx(async (c) => {
      const f = await fixture(c);
      const ruleA = await insertRule(c, f, { name: 'Internet' });
      const ruleB = await insertRule(c, f, { name: 'Luz' });
      expect(await tryInsertOccurrence(c, f.userId, ruleA, '2026-02-05')).toBeNull();
      expect(await tryInsertOccurrence(c, f.userId, ruleA, '2026-03-05')).toBeNull();
      expect(await tryInsertOccurrence(c, f.userId, ruleB, '2026-02-05')).toBeNull();
    });
  });
});

describe('RF-M14-14 amount is required in auto mode and optional in confirm mode', () => {
  it('RF-M14-14 an auto rule without amount violates the CHECK', async () => {
    await inTx(async (c) => {
      const f = await fixture(c);
      expect(await tryInsertRule(c, f, { mode: 'auto', amount: null })).toBe(CHECK_VIOLATION);
    });
  });

  it('RF-M14-14 a confirm rule without amount is accepted', async () => {
    await inTx(async (c) => {
      const f = await fixture(c);
      expect(await tryInsertRule(c, f, { mode: 'confirm', amount: null })).toBeNull();
    });
  });

  it('RF-M14-14 an auto rule with amount is accepted', async () => {
    await inTx(async (c) => {
      const f = await fixture(c);
      expect(await tryInsertRule(c, f, { mode: 'auto', amount: '150.00' })).toBeNull();
    });
  });
});

describe('RF-M14-15 rule name of 1 to 40 characters', () => {
  it('RF-M14-15 names of 1 and 40 characters are accepted', async () => {
    await inTx(async (c) => {
      const f = await fixture(c);
      expect(await tryInsertRule(c, f, { name: 'x' })).toBeNull();
      expect(await tryInsertRule(c, f, { name: 'x'.repeat(40) })).toBeNull();
    });
  });

  it.each(['', ' Internet', 'Internet '])(
    'RF-M14-15 the name "%s" violates the CHECK',
    async (name) => {
      await inTx(async (c) => {
        const f = await fixture(c);
        expect(await tryInsertRule(c, f, { name })).toBe(CHECK_VIOLATION);
      });
    },
  );

  it('RF-M14-15 a name of 41 characters is rejected', async () => {
    await inTx(async (c) => {
      const f = await fixture(c);
      expect(await tryInsertRule(c, f, { name: 'x'.repeat(41) })).toBe(STRING_TOO_LONG);
    });
  });
});

describe('RN-10 one event never produces two notifications', () => {
  it('RN-10 two notifications with the same event_key for the same user violate the unique constraint', async () => {
    await inTx(async (c) => {
      const userId = await insertUser(c);
      const key = 'debt:abc:due:2026-10-20:d-3';
      expect(await tryInsertNotification(c, userId, key)).toBeNull();
      expect(await tryInsertNotification(c, userId, key)).toBe(UNIQUE_VIOLATION);
    });
  });

  it('RN-10 the same event_key for two different users is accepted', async () => {
    await inTx(async (c) => {
      const userA = await insertUser(c);
      const userB = await insertUser(c);
      const key = 'debt:abc:due:2026-10-20:d-3';
      expect(await tryInsertNotification(c, userA, key)).toBeNull();
      expect(await tryInsertNotification(c, userB, key)).toBeNull();
    });
  });
});
