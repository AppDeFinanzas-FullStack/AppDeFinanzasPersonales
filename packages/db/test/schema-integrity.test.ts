import { randomBytes, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type pg from 'pg';
import { afterAll, describe, expect, it } from 'vitest';
import { closeSql, sql } from './helpers.js';

const FK_VIOLATION = '23503';

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

async function count(c: pg.PoolClient, text: string, values: unknown[] = []): Promise<number> {
  const { rows } = await c.query<{ n: string }>(
    `SELECT count(*)::text AS n FROM (${text}) q`,
    values,
  );
  return Number(rows[0]!.n);
}

function hex64(): string {
  return randomBytes(32).toString('hex');
}

// ---------------------------------------------------------------------------
// Fixtures (raw SQL, minimal valid rows)
// ---------------------------------------------------------------------------

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

const INSERT_ACCOUNT = `INSERT INTO account (id, user_id, type, name, currency_code, initial_balance_date,
                          color, icon, sort_order)
                        VALUES ($1, $2, 'bank', $3, 'BOB', '2026-01-01', '#22c55e', 'wallet', 0)`;

async function insertAccount(c: pg.PoolClient, userId: string, name = 'Banco'): Promise<string> {
  const id = randomUUID();
  await c.query(INSERT_ACCOUNT, [id, userId, `${name} ${id.slice(0, 8)}`]);
  return id;
}

async function insertCategory(
  c: pg.PoolClient,
  userId: string,
  kind: 'expense' | 'income' = 'expense',
): Promise<string> {
  const id = randomUUID();
  await c.query(
    `INSERT INTO category (id, user_id, kind, name, color, icon, sort_order)
     VALUES ($1, $2, $3, $4, '#22c55e', 'tag', 0)`,
    [id, userId, kind, `Cat ${id.slice(0, 8)}`],
  );
  return id;
}

interface TxInput {
  kind?: 'expense' | 'income' | 'transfer' | 'adjustment';
  categoryId?: string | null;
  origin?: string;
  parentTransactionId?: string | null;
  recurringRuleId?: string | null;
  recurringLabel?: string | null;
}

const INSERT_TX = `INSERT INTO ledger_transaction (id, user_id, kind, date, category_id, origin,
                     parent_transaction_id, recurring_rule_id, recurring_label, rate_cur_bob, rate_usd_bob)
                   VALUES ($1, $2, $3, '2026-03-10', $4, $5, $6, $7, $8, '1.00', '6.96')`;

function txValues(id: string, userId: string, a: TxInput): unknown[] {
  return [
    id,
    userId,
    a.kind ?? 'expense',
    a.categoryId ?? null,
    a.origin ?? 'manual',
    a.parentTransactionId ?? null,
    a.recurringRuleId ?? null,
    a.recurringLabel ?? null,
  ];
}

async function insertTx(c: pg.PoolClient, userId: string, a: TxInput = {}): Promise<string> {
  const id = randomUUID();
  await c.query(INSERT_TX, txValues(id, userId, a));
  return id;
}

function tryInsertTx(c: pg.PoolClient, userId: string, a: TxInput = {}): Promise<string | null> {
  return sqlState(c, INSERT_TX, txValues(randomUUID(), userId, a));
}

const INSERT_ENTRY = `INSERT INTO ledger_entry (id, user_id, transaction_id, account_id, amount, date)
                      VALUES ($1, $2, $3, $4, $5, '2026-03-10')`;

async function insertEntry(
  c: pg.PoolClient,
  userId: string,
  transactionId: string,
  accountId: string,
  amount: string,
): Promise<string> {
  const id = randomUUID();
  await c.query(INSERT_ENTRY, [id, userId, transactionId, accountId, amount]);
  return id;
}

const INSERT_RULE = `INSERT INTO recurring_rule (id, user_id, name, kind, amount, account_id,
                       category_id, frequency, day_of_month, start_date, mode)
                     VALUES ($1, $2, 'Internet', 'expense', '150.00', $3, $4, 'monthly', 5, '2026-01-05', 'auto')`;

async function insertRule(
  c: pg.PoolClient,
  userId: string,
  accountId: string,
  categoryId: string,
): Promise<string> {
  const id = randomUUID();
  await c.query(INSERT_RULE, [id, userId, accountId, categoryId]);
  return id;
}

const INSERT_SETTINGS = `INSERT INTO user_settings (user_id, dashboard_blocks, default_account_id)
                         VALUES ($1, '[]'::jsonb, $2)`;

const INSERT_FAVORITE = `INSERT INTO favorite_category (user_id, category_id, kind, position)
                         VALUES ($1, $2, 'expense', $3)`;

const INSERT_SHORTCUT_EXPENSE = `INSERT INTO shortcut (id, user_id, name, kind, amount, account_id, category_id, sort_order)
                                 VALUES ($1, $2, 'Cafe', 'expense', '15.00', $3, $4, 0)`;

const INSERT_SHORTCUT_TRANSFER = `INSERT INTO shortcut (id, user_id, name, kind, amount, account_id, dest_account_id, sort_order)
                                  VALUES ($1, $2, 'Ahorro', 'transfer', '100.00', $3, $4, 1)`;

const INSERT_BUDGET = `INSERT INTO budget (id, user_id, scope, category_id, amount, currency_code, start_day)
                       VALUES ($1, $2, 'category', $3, '500.00', 'BOB', 1)`;

const INSERT_GOAL = `INSERT INTO goal (id, user_id, name, target, currency_code, icon, color, dedicated_account_id)
                     VALUES ($1, $2, 'Viaje', '1000.00', 'BOB', 'plane', '#22c55e', $3)`;

const INSERT_ALLOCATION = `INSERT INTO goal_allocation_event (id, user_id, goal_id, account_id, amount, origin)
                           VALUES ($1, $2, $3, $4, '50.00', 'manual')`;

const INSERT_DEBT = `INSERT INTO debt (id, user_id, direction, person, person_key, principal, currency_code,
                       start_date, capital_outstanding, accrued_through)
                     VALUES ($1, $2, 'i_owe', 'Luis', 'luis', '200.00', 'BOB', '2026-01-01', '200.00', '2026-01-01')`;

const INSERT_DEBT_PAYMENT = `INSERT INTO debt_payment (id, user_id, debt_id, amount, interest_part, capital_part,
                               date, account_id)
                             VALUES ($1, $2, $3, '50.00', '0.00', '50.00', '2026-02-01', $4)`;

// ---------------------------------------------------------------------------
// Catalog helpers
// ---------------------------------------------------------------------------

interface ForeignKey {
  name: string;
  table: string;
  refTable: string;
  cols: string[];
  refCols: string[];
  delType: string;
  delSetCols: string[] | null;
}

async function foreignKeys(): Promise<ForeignKey[]> {
  const { rows } = await sql().query<ForeignKey>(
    `SELECT c.conname AS name,
            c.conrelid::regclass::text AS "table",
            c.confrelid::regclass::text AS "refTable",
            (SELECT array_agg(a.attname::text ORDER BY k.ord)
               FROM unnest(c.conkey) WITH ORDINALITY AS k(attnum, ord)
               JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = k.attnum) AS cols,
            (SELECT array_agg(a.attname::text ORDER BY k.ord)
               FROM unnest(c.confkey) WITH ORDINALITY AS k(attnum, ord)
               JOIN pg_attribute a ON a.attrelid = c.confrelid AND a.attnum = k.attnum) AS "refCols",
            c.confdeltype::text AS "delType",
            (SELECT array_agg(a.attname::text ORDER BY k.ord)
               FROM unnest(c.confdelsetcols) WITH ORDINALITY AS k(attnum, ord)
               JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = k.attnum) AS "delSetCols"
       FROM pg_constraint c
       JOIN pg_namespace n ON n.oid = c.connamespace
      WHERE c.contype = 'f' AND n.nspname = 'public'`,
  );
  return rows;
}

function findFk(fks: ForeignKey[], table: string, cols: string[]): ForeignKey | undefined {
  return fks.find((f) => f.table === table && JSON.stringify(f.cols) === JSON.stringify(cols));
}

/** Base tables of the public schema that have a user_id column. */
async function tablesWithUserId(c: pg.PoolClient | pg.Pool): Promise<string[]> {
  const { rows } = await c.query<{ table_name: string }>(
    `SELECT c.table_name
       FROM information_schema.columns c
       JOIN information_schema.tables t
         ON t.table_schema = c.table_schema AND t.table_name = c.table_name
      WHERE c.table_schema = 'public' AND c.column_name = 'user_id' AND t.table_type = 'BASE TABLE'
      ORDER BY c.table_name`,
  );
  return rows.map((r) => r.table_name);
}

function prismaModelBody(table: string): string {
  const path = fileURLToPath(new URL('../prisma/schema.prisma', import.meta.url));
  const source = readFileSync(path, 'utf8');
  const models = [...source.matchAll(/^\s*model\s+\w+\s*\{([^}]*)\}/gm)];
  const re = new RegExp(`@@map\\(\\s*"${table}"\\s*\\)`);
  const mapped = models.filter(([, body]) => re.test(body!));
  expect(mapped).toHaveLength(1);
  return mapped[0]![1]!;
}

// ---------------------------------------------------------------------------
// TASK-020: deferred foreign keys exist
// ---------------------------------------------------------------------------

describe('TASK-020 deferred foreign keys', () => {
  it('TASK-020 user_settings (user_id, default_account_id) references account (user_id, id) ON DELETE SET NULL (default_account_id)', async () => {
    const fk = findFk(await foreignKeys(), 'user_settings', ['user_id', 'default_account_id']);
    expect(fk).toBeDefined();
    expect(fk!.refTable).toBe('account');
    expect(fk!.refCols).toEqual(['user_id', 'id']);
    expect(fk!.delType).toBe('n');
    expect(fk!.delSetCols).toEqual(['default_account_id']);
  });

  it('TASK-020 favorite_category (user_id, category_id) references category (user_id, id) ON DELETE CASCADE', async () => {
    const fk = findFk(await foreignKeys(), 'favorite_category', ['user_id', 'category_id']);
    expect(fk).toBeDefined();
    expect(fk!.refTable).toBe('category');
    expect(fk!.refCols).toEqual(['user_id', 'id']);
    expect(fk!.delType).toBe('c');
  });

  it('TASK-020 ledger_transaction (user_id, recurring_rule_id) references recurring_rule (user_id, id) ON DELETE SET NULL (recurring_rule_id)', async () => {
    const fk = findFk(await foreignKeys(), 'ledger_transaction', ['user_id', 'recurring_rule_id']);
    expect(fk).toBeDefined();
    expect(fk!.refTable).toBe('recurring_rule');
    expect(fk!.refCols).toEqual(['user_id', 'id']);
    expect(fk!.delType).toBe('n');
    expect(fk!.delSetCols).toEqual(['recurring_rule_id']);
  });

  it.each([
    ['user_settings', 'defaultAccountId'],
    ['favorite_category', 'categoryId'],
    ['ledger_transaction', 'recurringRuleId'],
  ])('TASK-020 schema.prisma declares the relation of %s over [userId, %s]', (table, field) => {
    const body = prismaModelBody(table);
    const re = new RegExp(`@relation\\([^)]*fields:\\s*\\[\\s*userId\\s*,\\s*${field}\\s*\\]`);
    expect(body).toMatch(re);
  });

  it('TASK-020 a default account that does not exist is rejected', async () => {
    await inTx(async (c) => {
      const userId = await insertUser(c);
      expect(await sqlState(c, INSERT_SETTINGS, [userId, randomUUID()])).toBe(FK_VIOLATION);
      expect(await sqlState(c, INSERT_SETTINGS, [userId, null])).toBeNull();
    });
  });

  it('TASK-020 a favorite category that does not exist is rejected', async () => {
    await inTx(async (c) => {
      const userId = await insertUser(c);
      expect(await sqlState(c, INSERT_FAVORITE, [userId, randomUUID(), 1])).toBe(FK_VIOLATION);
      const categoryId = await insertCategory(c, userId);
      expect(await sqlState(c, INSERT_FAVORITE, [userId, categoryId, 1])).toBeNull();
    });
  });

  it('TASK-020 a recurring rule that does not exist is rejected in ledger_transaction', async () => {
    await inTx(async (c) => {
      const userId = await insertUser(c);
      const categoryId = await insertCategory(c, userId);
      expect(
        await tryInsertTx(c, userId, {
          categoryId,
          origin: 'recurring',
          recurringRuleId: randomUUID(),
          recurringLabel: 'Internet',
        }),
      ).toBe(FK_VIOLATION);
    });
  });

  it('TASK-020 deleting a category removes it from the favorites', async () => {
    await inTx(async (c) => {
      const userId = await insertUser(c);
      const categoryId = await insertCategory(c, userId);
      const otherId = await insertCategory(c, userId);
      await c.query(INSERT_FAVORITE, [userId, categoryId, 1]);
      await c.query(INSERT_FAVORITE, [userId, otherId, 2]);
      await c.query(`DELETE FROM category WHERE id = $1`, [categoryId]);
      expect(
        await count(c, `SELECT 1 FROM favorite_category WHERE user_id = $1 AND category_id = $2`, [
          userId,
          categoryId,
        ]),
      ).toBe(0);
      expect(
        await count(c, `SELECT 1 FROM favorite_category WHERE user_id = $1 AND category_id = $2`, [
          userId,
          otherId,
        ]),
      ).toBe(1);
    });
  });
});

// ---------------------------------------------------------------------------
// RF-M1-15: deleting the user removes all its data
// ---------------------------------------------------------------------------

/** Inserts at least one row of the user in every business table. */
async function fullDataset(c: pg.PoolClient, userId: string): Promise<{ periodId: string }> {
  await c.query(
    `INSERT INTO auth_session (id, token, user_id, expires_at, last_activity_at)
     VALUES ($1, $2, $3, now() + interval '1 day', now())`,
    [randomUUID(), hex64(), userId],
  );
  await c.query(
    `INSERT INTO auth_account (id, user_id, account_id, provider_id, password)
     VALUES ($1, $2, $3, 'credential', 'hash')`,
    [randomUUID(), userId, userId],
  );
  await c.query(
    `INSERT INTO email_link (id, user_id, purpose, token_hash, expires_at)
     VALUES ($1, $2, 'confirm_email', $3, now() + interval '1 day')`,
    [randomUUID(), userId, hex64()],
  );
  await c.query(
    `INSERT INTO signup_ticket (token_hash, user_id, expires_at)
     VALUES ($1, $2, now() + interval '1 day')`,
    [hex64(), userId],
  );
  await c.query(
    `INSERT INTO user_fx_event (id, user_id, kind, currency_code, value)
     VALUES ($1, $2, 'manual_usd_on', 'USD', '6.96')`,
    [randomUUID(), userId],
  );

  const accountId = await insertAccount(c, userId, 'Banco');
  const destId = await insertAccount(c, userId, 'Ahorro');
  const expenseCat = await insertCategory(c, userId, 'expense');

  await c.query(INSERT_SETTINGS, [userId, accountId]);
  await c.query(INSERT_FAVORITE, [userId, expenseCat, 1]);

  const ruleId = await insertRule(c, userId, accountId, expenseCat);
  const recurringTx = await insertTx(c, userId, {
    categoryId: expenseCat,
    origin: 'recurring',
    recurringRuleId: ruleId,
    recurringLabel: 'Internet',
  });
  await insertEntry(c, userId, recurringTx, accountId, '-150.00');

  const transferId = await insertTx(c, userId, { kind: 'transfer' });
  await insertEntry(c, userId, transferId, accountId, '-100.00');
  await insertEntry(c, userId, transferId, destId, '100.00');
  const feeId = await insertTx(c, userId, {
    categoryId: expenseCat,
    origin: 'fee',
    parentTransactionId: transferId,
  });
  await insertEntry(c, userId, feeId, accountId, '-2.00');

  await c.query(
    `INSERT INTO recurring_occurrence (id, user_id, rule_id, scheduled_date, status, transaction_id)
     VALUES ($1, $2, $3, '2026-03-05', 'registered', $4), ($5, $2, $3, '2026-04-05', 'pending', NULL)`,
    [randomUUID(), userId, ruleId, recurringTx, randomUUID()],
  );

  await c.query(
    `INSERT INTO undo_action (id, user_id, kind, payload, expires_at)
     VALUES ($1, $2, 'delete', '{}'::jsonb, now() + interval '12 seconds')`,
    [randomUUID(), userId],
  );
  await c.query(INSERT_SHORTCUT_EXPENSE, [randomUUID(), userId, accountId, expenseCat]);

  const budgetId = randomUUID();
  await c.query(INSERT_BUDGET, [budgetId, userId, expenseCat]);
  const periodId = randomUUID();
  const sourcePeriodId = randomUUID();
  await c.query(
    `INSERT INTO budget_period (id, user_id, budget_id, start_date, end_date, amount)
     VALUES ($1, $2, $3, '2026-03-01', '2026-03-31', '500.00'),
            ($4, $2, $3, '2026-02-01', '2026-02-28', '500.00')`,
    [periodId, userId, budgetId, sourcePeriodId],
  );
  await c.query(
    `INSERT INTO budget_late_adjustment (id, user_id, period_id, source_period_id, amount)
     VALUES ($1, $2, $3, $4, '10.00')`,
    [randomUUID(), userId, periodId, sourcePeriodId],
  );
  await c.query(`INSERT INTO budget_threshold_hit (period_id, threshold) VALUES ($1, 80)`, [
    periodId,
  ]);

  const goalId = randomUUID();
  await c.query(INSERT_GOAL, [goalId, userId, null]);
  await c.query(INSERT_ALLOCATION, [randomUUID(), userId, goalId, accountId]);

  const debtId = randomUUID();
  await c.query(INSERT_DEBT, [debtId, userId]);
  await c.query(INSERT_DEBT_PAYMENT, [randomUUID(), userId, debtId, accountId]);

  await c.query(
    `INSERT INTO notification (id, user_id, type, event_key, params, target_route)
     VALUES ($1, $2, 'payment_upcoming', $3, '{}'::jsonb, '/deudas')`,
    [randomUUID(), userId, `debt:${debtId}:due:2026-10-20:d-3`],
  );
  await c.query(
    `INSERT INTO notification_preference (user_id, type, enabled) VALUES ($1, 'payment_upcoming', true)`,
    [userId],
  );

  return { periodId };
}

describe('RF-M1-15 deleting auth_user removes every business row of the user', () => {
  it('RF-M1-15 every table with user_id references auth_user (id) ON DELETE CASCADE', async () => {
    const fks = await foreignKeys();
    const tables = await tablesWithUserId(sql());
    expect(tables.length).toBeGreaterThan(0);
    const missing = tables.filter((t) => {
      const fk = findFk(fks, t, ['user_id']);
      return !(fk && fk.refTable === 'auth_user' && fk.delType === 'c');
    });
    expect(missing).toEqual([]);
  });

  it('RF-M1-15 deleting auth_user leaves 0 rows of the user in every business table', async () => {
    await inTx(async (c) => {
      const userId = await insertUser(c);
      const other = await insertUser(c);
      const { periodId } = await fullDataset(c, userId);
      await fullDataset(c, other);
      const tables = await tablesWithUserId(c);

      // The dataset covers every table, so the check below is meaningful.
      const empty: string[] = [];
      for (const t of tables) {
        if ((await count(c, `SELECT 1 FROM ${t} WHERE user_id = $1`, [userId])) === 0)
          empty.push(t);
      }
      expect(empty).toEqual([]);

      await c.query(`DELETE FROM auth_user WHERE id = $1`, [userId]);

      const left: string[] = [];
      for (const t of tables) {
        if ((await count(c, `SELECT 1 FROM ${t} WHERE user_id = $1`, [userId])) > 0) left.push(t);
      }
      expect(left).toEqual([]);
      expect(
        await count(c, `SELECT 1 FROM budget_threshold_hit WHERE period_id = $1`, [periodId]),
      ).toBe(0);

      // The other user keeps its data.
      const otherEmpty: string[] = [];
      for (const t of tables) {
        if ((await count(c, `SELECT 1 FROM ${t} WHERE user_id = $1`, [other])) === 0)
          otherEmpty.push(t);
      }
      expect(otherEmpty).toEqual([]);
    });
  });

  it('RF-M1-15 the confirmation email queued in email_outbox survives the deletion', async () => {
    await inTx(async (c) => {
      const userId = await insertUser(c);
      await fullDataset(c, userId);
      const outboxId = randomUUID();
      await c.query(
        `INSERT INTO email_outbox (id, to_address, kind, payload) VALUES ($1, $2, 'account_deleted', '{}')`,
        [outboxId, `${userId}@test.local`],
      );
      await c.query(`DELETE FROM auth_user WHERE id = $1`, [userId]);
      expect(await count(c, `SELECT 1 FROM email_outbox WHERE id = $1`, [outboxId])).toBe(1);
    });
  });
});

// ---------------------------------------------------------------------------
// RN-08: what has history is archived, not deleted
// ---------------------------------------------------------------------------

describe('RN-08 accounts and categories with history cannot be deleted', () => {
  it('RN-08 an account with ledger entries cannot be deleted', async () => {
    await inTx(async (c) => {
      const userId = await insertUser(c);
      const accountId = await insertAccount(c, userId);
      const categoryId = await insertCategory(c, userId);
      const txId = await insertTx(c, userId, { categoryId });
      await insertEntry(c, userId, txId, accountId, '-10.00');
      expect(await sqlState(c, `DELETE FROM account WHERE id = $1`, [accountId])).toBe(
        FK_VIOLATION,
      );
      expect(await count(c, `SELECT 1 FROM account WHERE id = $1`, [accountId])).toBe(1);
    });
  });

  it('RN-08 an account whose only entry belongs to a deleted (undoable) movement still cannot be deleted', async () => {
    await inTx(async (c) => {
      const userId = await insertUser(c);
      const accountId = await insertAccount(c, userId);
      const categoryId = await insertCategory(c, userId);
      const txId = await insertTx(c, userId, { categoryId });
      await insertEntry(c, userId, txId, accountId, '-10.00');
      await c.query(`UPDATE ledger_transaction SET deleted_at = now() WHERE id = $1`, [txId]);
      expect(await sqlState(c, `DELETE FROM account WHERE id = $1`, [accountId])).toBe(
        FK_VIOLATION,
      );
    });
  });

  it('RN-08 a category with movements cannot be deleted', async () => {
    await inTx(async (c) => {
      const userId = await insertUser(c);
      const accountId = await insertAccount(c, userId);
      const categoryId = await insertCategory(c, userId);
      const txId = await insertTx(c, userId, { categoryId });
      await insertEntry(c, userId, txId, accountId, '-10.00');
      expect(await sqlState(c, `DELETE FROM category WHERE id = $1`, [categoryId])).toBe(
        FK_VIOLATION,
      );
      expect(await count(c, `SELECT 1 FROM category WHERE id = $1`, [categoryId])).toBe(1);
    });
  });

  it('RN-08 a category used by a budget cannot be deleted', async () => {
    await inTx(async (c) => {
      const userId = await insertUser(c);
      const categoryId = await insertCategory(c, userId);
      await c.query(INSERT_BUDGET, [randomUUID(), userId, categoryId]);
      expect(await sqlState(c, `DELETE FROM category WHERE id = $1`, [categoryId])).toBe(
        FK_VIOLATION,
      );
    });
  });

  it('RN-08 an account or category used by a recurring rule cannot be deleted', async () => {
    await inTx(async (c) => {
      const userId = await insertUser(c);
      const accountId = await insertAccount(c, userId);
      const categoryId = await insertCategory(c, userId);
      await insertRule(c, userId, accountId, categoryId);
      expect(await sqlState(c, `DELETE FROM account WHERE id = $1`, [accountId])).toBe(
        FK_VIOLATION,
      );
      expect(await sqlState(c, `DELETE FROM category WHERE id = $1`, [categoryId])).toBe(
        FK_VIOLATION,
      );
    });
  });

  it('RN-08 an account and a category without history can be deleted', async () => {
    await inTx(async (c) => {
      const userId = await insertUser(c);
      const accountId = await insertAccount(c, userId);
      const categoryId = await insertCategory(c, userId);
      expect(await sqlState(c, `DELETE FROM account WHERE id = $1`, [accountId])).toBeNull();
      expect(await sqlState(c, `DELETE FROM category WHERE id = $1`, [categoryId])).toBeNull();
    });
  });
});

// ---------------------------------------------------------------------------
// RF-M4-13: deleting an account without movements
// ---------------------------------------------------------------------------

describe('RF-M4-13 deleting an account without movements', () => {
  it('RF-M4-13 the shortcuts of the account (origin or destination) cascade with it', async () => {
    await inTx(async (c) => {
      const userId = await insertUser(c);
      const accountId = await insertAccount(c, userId, 'Banco');
      const otherId = await insertAccount(c, userId, 'Otra');
      const categoryId = await insertCategory(c, userId);
      const asOrigin = randomUUID();
      const asDest = randomUUID();
      const unrelated = randomUUID();
      await c.query(INSERT_SHORTCUT_EXPENSE, [asOrigin, userId, accountId, categoryId]);
      await c.query(INSERT_SHORTCUT_TRANSFER, [asDest, userId, otherId, accountId]);
      await c.query(INSERT_SHORTCUT_EXPENSE, [unrelated, userId, otherId, categoryId]);

      await c.query(`DELETE FROM account WHERE id = $1`, [accountId]);

      expect(
        await count(c, `SELECT 1 FROM shortcut WHERE id = ANY($1::uuid[])`, [[asOrigin, asDest]]),
      ).toBe(0);
      expect(await count(c, `SELECT 1 FROM shortcut WHERE id = $1`, [unrelated])).toBe(1);
    });
  });

  it('RF-M4-13 the account stops being the default account and the settings row is kept', async () => {
    await inTx(async (c) => {
      const userId = await insertUser(c);
      const accountId = await insertAccount(c, userId);
      await c.query(INSERT_SETTINGS, [userId, accountId]);

      await c.query(`DELETE FROM account WHERE id = $1`, [accountId]);

      const { rows } = await c.query<{ user_id: string; default_account_id: string | null }>(
        `SELECT user_id, default_account_id FROM user_settings WHERE user_id = $1`,
        [userId],
      );
      expect(rows).toEqual([{ user_id: userId, default_account_id: null }]);
    });
  });

  it('RF-M4-13 deleting another account keeps the default account', async () => {
    await inTx(async (c) => {
      const userId = await insertUser(c);
      const accountId = await insertAccount(c, userId, 'Banco');
      const otherId = await insertAccount(c, userId, 'Otra');
      await c.query(INSERT_SETTINGS, [userId, accountId]);
      await c.query(`DELETE FROM account WHERE id = $1`, [otherId]);
      const { rows } = await c.query<{ default_account_id: string | null }>(
        `SELECT default_account_id FROM user_settings WHERE user_id = $1`,
        [userId],
      );
      expect(rows[0]!.default_account_id).toBe(accountId);
    });
  });

  it('RF-M4-13 the shortcuts of a deleted category cascade with it', async () => {
    await inTx(async (c) => {
      const userId = await insertUser(c);
      const accountId = await insertAccount(c, userId);
      const categoryId = await insertCategory(c, userId);
      const shortcutId = randomUUID();
      await c.query(INSERT_SHORTCUT_EXPENSE, [shortcutId, userId, accountId, categoryId]);
      await c.query(`DELETE FROM category WHERE id = $1`, [categoryId]);
      expect(await count(c, `SELECT 1 FROM shortcut WHERE id = $1`, [shortcutId])).toBe(0);
    });
  });
});

// ---------------------------------------------------------------------------
// RF-M6-05: the fee is deleted with its transfer
// ---------------------------------------------------------------------------

describe('RF-M6-05 the fee cascades with its transfer', () => {
  it('RF-M6-05 deleting a transfer deletes its fee and the fee entries', async () => {
    await inTx(async (c) => {
      const userId = await insertUser(c);
      const fromId = await insertAccount(c, userId, 'Origen');
      const toId = await insertAccount(c, userId, 'Destino');
      const categoryId = await insertCategory(c, userId);
      const transferId = await insertTx(c, userId, { kind: 'transfer' });
      await insertEntry(c, userId, transferId, fromId, '-100.00');
      await insertEntry(c, userId, transferId, toId, '100.00');
      const feeId = await insertTx(c, userId, {
        categoryId,
        origin: 'fee',
        parentTransactionId: transferId,
      });
      const feeEntry = await insertEntry(c, userId, feeId, fromId, '-5.00');
      const otherTx = await insertTx(c, userId, { categoryId });

      await c.query(`DELETE FROM ledger_transaction WHERE id = $1`, [transferId]);

      expect(await count(c, `SELECT 1 FROM ledger_transaction WHERE id = $1`, [feeId])).toBe(0);
      expect(await count(c, `SELECT 1 FROM ledger_entry WHERE id = $1`, [feeEntry])).toBe(0);
      expect(
        await count(c, `SELECT 1 FROM ledger_entry WHERE transaction_id = $1`, [transferId]),
      ).toBe(0);
      expect(await count(c, `SELECT 1 FROM ledger_transaction WHERE id = $1`, [otherTx])).toBe(1);
    });
  });
});

// ---------------------------------------------------------------------------
// RF-M14-11: deleting a rule keeps its movements and removes its pending occurrences
// ---------------------------------------------------------------------------

describe('RF-M14-11 deleting a recurring rule', () => {
  it('RF-M14-11 its movements stay with recurring_rule_id = NULL and keep recurring_label', async () => {
    await inTx(async (c) => {
      const userId = await insertUser(c);
      const accountId = await insertAccount(c, userId);
      const categoryId = await insertCategory(c, userId);
      const ruleId = await insertRule(c, userId, accountId, categoryId);
      const txId = await insertTx(c, userId, {
        categoryId,
        origin: 'recurring',
        recurringRuleId: ruleId,
        recurringLabel: 'Internet',
      });
      await insertEntry(c, userId, txId, accountId, '-150.00');
      await c.query(
        `INSERT INTO recurring_occurrence (id, user_id, rule_id, scheduled_date, status, transaction_id)
         VALUES ($1, $2, $3, '2026-03-05', 'registered', $4)`,
        [randomUUID(), userId, ruleId, txId],
      );

      await c.query(`DELETE FROM recurring_rule WHERE id = $1`, [ruleId]);

      const { rows } = await c.query<{
        user_id: string;
        recurring_rule_id: string | null;
        recurring_label: string | null;
        origin: string;
      }>(
        `SELECT user_id, recurring_rule_id, recurring_label, origin::text AS origin
           FROM ledger_transaction WHERE id = $1`,
        [txId],
      );
      expect(rows).toEqual([
        {
          user_id: userId,
          recurring_rule_id: null,
          recurring_label: 'Internet',
          origin: 'recurring',
        },
      ]);
      expect(await count(c, `SELECT 1 FROM ledger_entry WHERE transaction_id = $1`, [txId])).toBe(
        1,
      );
    });
  });

  it('RF-M14-11 its pending occurrences are deleted with it', async () => {
    await inTx(async (c) => {
      const userId = await insertUser(c);
      const accountId = await insertAccount(c, userId);
      const categoryId = await insertCategory(c, userId);
      const ruleId = await insertRule(c, userId, accountId, categoryId);
      await c.query(
        `INSERT INTO recurring_occurrence (id, user_id, rule_id, scheduled_date, status, pending_since)
         VALUES ($1, $2, $3, '2026-04-05', 'pending', now())`,
        [randomUUID(), userId, ruleId],
      );
      await c.query(`DELETE FROM recurring_rule WHERE id = $1`, [ruleId]);
      expect(
        await count(c, `SELECT 1 FROM recurring_occurrence WHERE rule_id = $1`, [ruleId]),
      ).toBe(0);
    });
  });
});

// ---------------------------------------------------------------------------
// RN-09: composite foreign keys never accept a resource of another user
// ---------------------------------------------------------------------------

describe('RN-09 composite foreign keys reject resources of another user', () => {
  it('RN-09 every composite foreign key pairs user_id with user_id of the referenced table', async () => {
    const composite = (await foreignKeys()).filter((f) => f.cols.length > 1);
    expect(composite.length).toBeGreaterThan(0);
    const wrong = composite
      .filter((f) => {
        const i = f.cols.indexOf('user_id');
        return i === -1 || f.refCols[i] !== 'user_id';
      })
      .map((f) => f.name);
    expect(wrong).toEqual([]);
  });

  it('RN-09 user_settings rejects a default account of another user', async () => {
    await inTx(async (c) => {
      const a = await insertUser(c);
      const b = await insertUser(c);
      const foreign = await insertAccount(c, b);
      expect(await sqlState(c, INSERT_SETTINGS, [a, foreign])).toBe(FK_VIOLATION);
      const own = await insertAccount(c, a);
      expect(await sqlState(c, INSERT_SETTINGS, [a, own])).toBeNull();
    });
  });

  it('RN-09 user_settings cannot be updated to point to an account of another user', async () => {
    await inTx(async (c) => {
      const a = await insertUser(c);
      const b = await insertUser(c);
      await c.query(INSERT_SETTINGS, [a, null]);
      const foreign = await insertAccount(c, b);
      expect(
        await sqlState(c, `UPDATE user_settings SET default_account_id = $2 WHERE user_id = $1`, [
          a,
          foreign,
        ]),
      ).toBe(FK_VIOLATION);
    });
  });

  it('RN-09 favorite_category rejects a category of another user', async () => {
    await inTx(async (c) => {
      const a = await insertUser(c);
      const b = await insertUser(c);
      const foreign = await insertCategory(c, b);
      expect(await sqlState(c, INSERT_FAVORITE, [a, foreign, 1])).toBe(FK_VIOLATION);
    });
  });

  it('RN-09 ledger_transaction rejects a recurring rule of another user', async () => {
    await inTx(async (c) => {
      const a = await insertUser(c);
      const b = await insertUser(c);
      const foreignRule = await insertRule(
        c,
        b,
        await insertAccount(c, b),
        await insertCategory(c, b),
      );
      const ownCategory = await insertCategory(c, a);
      expect(
        await tryInsertTx(c, a, {
          categoryId: ownCategory,
          origin: 'recurring',
          recurringRuleId: foreignRule,
          recurringLabel: 'Internet',
        }),
      ).toBe(FK_VIOLATION);
      const ownRule = await insertRule(c, a, await insertAccount(c, a), ownCategory);
      expect(
        await tryInsertTx(c, a, {
          categoryId: ownCategory,
          origin: 'recurring',
          recurringRuleId: ownRule,
          recurringLabel: 'Internet',
        }),
      ).toBeNull();
    });
  });

  it('RN-09 ledger_transaction rejects a category of another user', async () => {
    await inTx(async (c) => {
      const a = await insertUser(c);
      const b = await insertUser(c);
      const foreign = await insertCategory(c, b);
      expect(await tryInsertTx(c, a, { categoryId: foreign })).toBe(FK_VIOLATION);
    });
  });

  it('RN-09 ledger_entry rejects an account of another user', async () => {
    await inTx(async (c) => {
      const a = await insertUser(c);
      const b = await insertUser(c);
      const txId = await insertTx(c, a, { categoryId: await insertCategory(c, a) });
      const foreign = await insertAccount(c, b);
      expect(await sqlState(c, INSERT_ENTRY, [randomUUID(), a, txId, foreign, '-1.00'])).toBe(
        FK_VIOLATION,
      );
    });
  });

  it('RN-09 shortcut rejects an account, a destination or a category of another user', async () => {
    await inTx(async (c) => {
      const a = await insertUser(c);
      const b = await insertUser(c);
      const ownAccount = await insertAccount(c, a, 'Propia');
      const ownCategory = await insertCategory(c, a);
      const foreignAccount = await insertAccount(c, b);
      const foreignCategory = await insertCategory(c, b);
      expect(
        await sqlState(c, INSERT_SHORTCUT_EXPENSE, [randomUUID(), a, foreignAccount, ownCategory]),
      ).toBe(FK_VIOLATION);
      expect(
        await sqlState(c, INSERT_SHORTCUT_EXPENSE, [randomUUID(), a, ownAccount, foreignCategory]),
      ).toBe(FK_VIOLATION);
      expect(
        await sqlState(c, INSERT_SHORTCUT_TRANSFER, [randomUUID(), a, ownAccount, foreignAccount]),
      ).toBe(FK_VIOLATION);
    });
  });

  it('RN-09 budget rejects a category of another user', async () => {
    await inTx(async (c) => {
      const a = await insertUser(c);
      const b = await insertUser(c);
      const foreign = await insertCategory(c, b);
      expect(await sqlState(c, INSERT_BUDGET, [randomUUID(), a, foreign])).toBe(FK_VIOLATION);
    });
  });

  it('RN-09 goal and goal_allocation_event reject an account or a goal of another user', async () => {
    await inTx(async (c) => {
      const a = await insertUser(c);
      const b = await insertUser(c);
      const foreignAccount = await insertAccount(c, b);
      expect(await sqlState(c, INSERT_GOAL, [randomUUID(), a, foreignAccount])).toBe(FK_VIOLATION);
      const foreignGoal = randomUUID();
      await c.query(INSERT_GOAL, [foreignGoal, b, null]);
      const ownAccount = await insertAccount(c, a);
      expect(await sqlState(c, INSERT_ALLOCATION, [randomUUID(), a, foreignGoal, ownAccount])).toBe(
        FK_VIOLATION,
      );
      const ownGoal = randomUUID();
      await c.query(INSERT_GOAL, [ownGoal, a, null]);
      expect(await sqlState(c, INSERT_ALLOCATION, [randomUUID(), a, ownGoal, foreignAccount])).toBe(
        FK_VIOLATION,
      );
    });
  });

  it('RN-09 debt_payment rejects an account of another user', async () => {
    await inTx(async (c) => {
      const a = await insertUser(c);
      const b = await insertUser(c);
      const debtId = randomUUID();
      await c.query(INSERT_DEBT, [debtId, a]);
      const foreign = await insertAccount(c, b);
      expect(await sqlState(c, INSERT_DEBT_PAYMENT, [randomUUID(), a, debtId, foreign])).toBe(
        FK_VIOLATION,
      );
    });
  });

  it('RN-09 recurring_rule rejects an account or a category of another user', async () => {
    await inTx(async (c) => {
      const a = await insertUser(c);
      const b = await insertUser(c);
      const ownAccount = await insertAccount(c, a);
      const ownCategory = await insertCategory(c, a);
      const foreignAccount = await insertAccount(c, b);
      const foreignCategory = await insertCategory(c, b);
      expect(await sqlState(c, INSERT_RULE, [randomUUID(), a, foreignAccount, ownCategory])).toBe(
        FK_VIOLATION,
      );
      expect(await sqlState(c, INSERT_RULE, [randomUUID(), a, ownAccount, foreignCategory])).toBe(
        FK_VIOLATION,
      );
    });
  });
});
