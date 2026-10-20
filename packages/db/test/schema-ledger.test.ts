import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type pg from 'pg';
import { afterAll, describe, expect, it } from 'vitest';
import { closeSql, sql } from './helpers.js';

const CHECK_VIOLATION = '23514';
const FK_VIOLATION = '23503';
const NOT_NULL_VIOLATION = '23502';
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

async function insertAccount(c: pg.PoolClient, userId: string, name = 'Banco'): Promise<string> {
  const id = randomUUID();
  await c.query(
    `INSERT INTO account (id, user_id, type, name, currency_code, initial_balance_date,
                          color, icon, sort_order)
     VALUES ($1, $2, 'bank', $3, 'BOB', '2026-01-01', '#22c55e', 'wallet', 0)`,
    [id, userId, name],
  );
  return id;
}

async function insertCategory(
  c: pg.PoolClient,
  userId: string,
  kind: 'expense' | 'income' = 'expense',
  name = 'Comida',
): Promise<string> {
  const id = randomUUID();
  await c.query(
    `INSERT INTO category (id, user_id, kind, name, color, icon, sort_order)
     VALUES ($1, $2, $3, $4, '#22c55e', 'tag', 0)`,
    [id, userId, kind, name],
  );
  return id;
}

interface TxInput {
  id?: string;
  kind?: 'expense' | 'income' | 'transfer' | 'adjustment';
  date?: string;
  note?: string | null;
  categoryId?: string | null;
  origin?: string;
  parentTransactionId?: string | null;
  rateCurBob?: string | null;
  rateUsdBob?: string | null;
  declaredRate?: string | null;
}

const INSERT_TX = `INSERT INTO ledger_transaction (id, user_id, kind, date, note, category_id, origin,
                     parent_transaction_id, rate_cur_bob, rate_usd_bob, declared_rate)
                   VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`;

function txValues(userId: string, a: TxInput): unknown[] {
  return [
    a.id ?? randomUUID(),
    userId,
    a.kind ?? 'expense',
    a.date ?? '2026-03-10',
    a.note ?? null,
    a.categoryId ?? null,
    a.origin ?? 'manual',
    a.parentTransactionId ?? null,
    a.rateCurBob !== undefined ? a.rateCurBob : '1.00',
    a.rateUsdBob !== undefined ? a.rateUsdBob : '6.96',
    a.declaredRate ?? null,
  ];
}

function tryInsertTx(c: pg.PoolClient, userId: string, a: TxInput = {}): Promise<string | null> {
  return sqlState(c, INSERT_TX, txValues(userId, a));
}

async function insertTx(c: pg.PoolClient, userId: string, a: TxInput = {}): Promise<string> {
  const id = a.id ?? randomUUID();
  await c.query(INSERT_TX, txValues(userId, { ...a, id }));
  return id;
}

const INSERT_ENTRY = `INSERT INTO ledger_entry (id, user_id, transaction_id, account_id, amount, date)
                      VALUES ($1, $2, $3, $4, $5, $6)`;

function tryInsertEntry(
  c: pg.PoolClient,
  userId: string,
  transactionId: string,
  accountId: string,
  amount: string,
  date = '2026-03-10',
): Promise<string | null> {
  return sqlState(c, INSERT_ENTRY, [randomUUID(), userId, transactionId, accountId, amount, date]);
}

interface ShortcutInput {
  name?: string;
  kind?: 'expense' | 'income' | 'transfer';
  amount?: string | null;
  accountId: string;
  destAccountId?: string | null;
  categoryId?: string | null;
  note?: string | null;
}

const INSERT_SHORTCUT = `INSERT INTO shortcut (id, user_id, name, kind, amount, account_id,
                           dest_account_id, category_id, note, sort_order)
                         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 0)`;

function tryInsertShortcut(
  c: pg.PoolClient,
  userId: string,
  a: ShortcutInput,
): Promise<string | null> {
  return sqlState(c, INSERT_SHORTCUT, [
    randomUUID(),
    userId,
    a.name ?? 'Almuerzo',
    a.kind ?? 'expense',
    a.amount ?? null,
    a.accountId,
    a.destAccountId ?? null,
    a.categoryId ?? null,
    a.note ?? null,
  ]);
}

async function indexDefs(table: string): Promise<string[]> {
  const { rows } = await sql().query<{ indexdef: string }>(
    `SELECT indexdef FROM pg_indexes WHERE schemaname = 'public' AND tablename = $1`,
    [table],
  );
  return rows.map((r) => r.indexdef);
}

describe('TASK-016 ledger tables and indexes exist', () => {
  it.each(['ledger_transaction', 'ledger_entry', 'undo_action', 'shortcut'])(
    'TASK-016 the table %s exists',
    async (table) => {
      const { rows } = await sql().query<{ reg: string | null }>(
        `SELECT to_regclass('public.' || $1)::text AS reg`,
        [table],
      );
      expect(rows[0]!.reg).toBe(table);
    },
  );

  it.each(['ledger_transaction', 'ledger_entry', 'undo_action', 'shortcut'])(
    'TASK-016 schema.prisma declares a model mapped to %s',
    (table) => {
      const path = fileURLToPath(new URL('../prisma/schema.prisma', import.meta.url));
      const source = readFileSync(path, 'utf8');
      const models = [...source.matchAll(/^\s*model\s+\w+\s*\{([^}]*)\}/gm)];
      const re = new RegExp(`@@map\\(\\s*"${table}"\\s*\\)`);
      const mapped = models.filter(([, body]) => re.test(body!));
      expect(mapped).toHaveLength(1);
    },
  );

  it('TASK-016 ledger_transaction has the column recurring_rule_id', async () => {
    const { rows } = await sql().query<{ data_type: string }>(
      `SELECT data_type FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'ledger_transaction'
          AND column_name = 'recurring_rule_id'`,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.data_type).toBe('uuid');
  });

  it('TASK-016 the index ledger_tx_list is on (user_id, date DESC, created_at DESC, id) for non-deleted rows', async () => {
    const { rows } = await sql().query<{ indexdef: string }>(
      `SELECT indexdef FROM pg_indexes WHERE schemaname = 'public'
          AND tablename = 'ledger_transaction' AND indexname = 'ledger_tx_list'`,
    );
    expect(rows).toHaveLength(1);
    const def = rows[0]!.indexdef;
    expect(def).toMatch(/\(user_id, date DESC, created_at DESC, id\)/);
    expect(def).toMatch(/WHERE \(deleted_at IS NULL\)/);
  });

  it('TASK-016 ledger_transaction has an index on (user_id, category_id, date) for non-deleted rows', async () => {
    const defs = await indexDefs('ledger_transaction');
    expect(
      defs.some(
        (d) => /\(user_id, category_id, date\)/.test(d) && /WHERE \(deleted_at IS NULL\)/.test(d),
      ),
    ).toBe(true);
  });

  it('TASK-016 ledger_transaction has an index on deleted_at for deleted rows', async () => {
    const defs = await indexDefs('ledger_transaction');
    expect(
      defs.some((d) => /\(deleted_at\)/.test(d) && /WHERE \(deleted_at IS NOT NULL\)/.test(d)),
    ).toBe(true);
  });

  it('TASK-016 the index ledger_entry_balance is on (user_id, account_id, date)', async () => {
    const { rows } = await sql().query<{ indexdef: string }>(
      `SELECT indexdef FROM pg_indexes WHERE schemaname = 'public'
          AND tablename = 'ledger_entry' AND indexname = 'ledger_entry_balance'`,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.indexdef).toMatch(/\(user_id, account_id, date\)/);
  });

  it('TASK-016 ledger_entry has an index on transaction_id', async () => {
    const defs = await indexDefs('ledger_entry');
    expect(defs.some((d) => /\(transaction_id\)/.test(d))).toBe(true);
  });

  it('TASK-016 undo_action has an index on expires_at', async () => {
    const defs = await indexDefs('undo_action');
    expect(defs.some((d) => /\(expires_at\)/.test(d))).toBe(true);
  });
});

describe('TASK-016 ledger_transaction', () => {
  it('TASK-016 a minimal transaction takes the defaults origin manual and deleted_at null', async () => {
    await inTx(async (c) => {
      const userId = await insertUser(c);
      const cat = await insertCategory(c, userId);
      const id = randomUUID();
      await c.query(
        `INSERT INTO ledger_transaction (id, user_id, kind, date, category_id, rate_cur_bob)
         VALUES ($1, $2, 'expense', '2026-03-10', $3, 1.00)`,
        [id, userId, cat],
      );
      const { rows } = await c.query(
        `SELECT origin::text AS origin, deleted_at, note, rate_usd_bob, declared_rate
           FROM ledger_transaction WHERE id = $1`,
        [id],
      );
      expect(rows[0]).toEqual({
        origin: 'manual',
        deleted_at: null,
        note: null,
        rate_usd_bob: null,
        declared_rate: null,
      });
    });
  });

  it.each(['expense', 'income'] as const)(
    'TASK-016 a %s without category violates the CHECK',
    async (kind) => {
      await inTx(async (c) => {
        const userId = await insertUser(c);
        expect(await tryInsertTx(c, userId, { kind, categoryId: null })).toBe(CHECK_VIOLATION);
      });
    },
  );

  it.each(['expense', 'income'] as const)(
    'TASK-016 a %s with a category of its user is accepted',
    async (kind) => {
      await inTx(async (c) => {
        const userId = await insertUser(c);
        const cat = await insertCategory(c, userId, kind);
        expect(await tryInsertTx(c, userId, { kind, categoryId: cat })).toBeNull();
      });
    },
  );

  it.each(['transfer', 'adjustment'] as const)(
    'TASK-016 a %s with category violates the CHECK',
    async (kind) => {
      await inTx(async (c) => {
        const userId = await insertUser(c);
        const cat = await insertCategory(c, userId);
        expect(await tryInsertTx(c, userId, { kind, categoryId: cat })).toBe(CHECK_VIOLATION);
      });
    },
  );

  it.each(['transfer', 'adjustment'] as const)(
    'TASK-016 a %s without category is accepted',
    async (kind) => {
      await inTx(async (c) => {
        const userId = await insertUser(c);
        expect(await tryInsertTx(c, userId, { kind, categoryId: null })).toBeNull();
      });
    },
  );

  it('TASK-016 declared_rate is accepted in a transfer', async () => {
    await inTx(async (c) => {
      const userId = await insertUser(c);
      expect(await tryInsertTx(c, userId, { kind: 'transfer', declaredRate: '6.90' })).toBeNull();
    });
  });

  it.each(['expense', 'income'] as const)(
    'TASK-016 declared_rate in a %s violates the CHECK',
    async (kind) => {
      await inTx(async (c) => {
        const userId = await insertUser(c);
        const cat = await insertCategory(c, userId, kind);
        expect(await tryInsertTx(c, userId, { kind, categoryId: cat, declaredRate: '6.90' })).toBe(
          CHECK_VIOLATION,
        );
      });
    },
  );

  it('TASK-016 declared_rate in an adjustment violates the CHECK', async () => {
    await inTx(async (c) => {
      const userId = await insertUser(c);
      expect(await tryInsertTx(c, userId, { kind: 'adjustment', declaredRate: '6.90' })).toBe(
        CHECK_VIOLATION,
      );
    });
  });

  it('TASK-016 origin fee without parent_transaction_id violates the CHECK', async () => {
    await inTx(async (c) => {
      const userId = await insertUser(c);
      const cat = await insertCategory(c, userId);
      expect(
        await tryInsertTx(c, userId, { categoryId: cat, origin: 'fee', parentTransactionId: null }),
      ).toBe(CHECK_VIOLATION);
    });
  });

  it('TASK-016 parent_transaction_id without origin fee violates the CHECK', async () => {
    await inTx(async (c) => {
      const userId = await insertUser(c);
      const cat = await insertCategory(c, userId);
      const parent = await insertTx(c, userId, { kind: 'transfer' });
      expect(
        await tryInsertTx(c, userId, {
          categoryId: cat,
          origin: 'manual',
          parentTransactionId: parent,
        }),
      ).toBe(CHECK_VIOLATION);
    });
  });

  it('TASK-016 a fee with its parent transfer is accepted and is deleted with it', async () => {
    await inTx(async (c) => {
      const userId = await insertUser(c);
      const cat = await insertCategory(c, userId);
      const parent = await insertTx(c, userId, { kind: 'transfer' });
      const fee = await insertTx(c, userId, {
        categoryId: cat,
        origin: 'fee',
        parentTransactionId: parent,
      });
      await c.query(`DELETE FROM ledger_transaction WHERE id = $1`, [parent]);
      const r = await c.query(`SELECT 1 FROM ledger_transaction WHERE id = $1`, [fee]);
      expect(r.rowCount).toBe(0);
    });
  });

  it('TASK-016 rate_cur_bob is required', async () => {
    await inTx(async (c) => {
      const userId = await insertUser(c);
      expect(await tryInsertTx(c, userId, { kind: 'transfer', rateCurBob: null })).toBe(
        NOT_NULL_VIOLATION,
      );
    });
  });

  it.each([
    ['rateCurBob', '0.00'],
    ['rateUsdBob', '0.00'],
    ['declaredRate', '0.00'],
  ] as const)('TASK-016 %s below 0.01 violates the CHECK', async (field, value) => {
    await inTx(async (c) => {
      const userId = await insertUser(c);
      expect(await tryInsertTx(c, userId, { kind: 'transfer', [field]: value })).toBe(
        CHECK_VIOLATION,
      );
    });
  });

  it('TASK-016 rate_usd_bob may be null', async () => {
    await inTx(async (c) => {
      const userId = await insertUser(c);
      expect(await tryInsertTx(c, userId, { kind: 'transfer', rateUsdBob: null })).toBeNull();
    });
  });

  it('TASK-016 a category with transactions cannot be deleted', async () => {
    await inTx(async (c) => {
      const userId = await insertUser(c);
      const cat = await insertCategory(c, userId);
      await insertTx(c, userId, { categoryId: cat });
      expect(await sqlState(c, `DELETE FROM category WHERE id = $1`, [cat])).toBe(FK_VIOLATION);
    });
  });
});

describe('RF-M6-03 the note is optional and up to 140 characters', () => {
  it.each([null, 'x', 'x'.repeat(140)])(
    'RF-M6-03 a transaction with the note %j is accepted',
    async (note) => {
      await inTx(async (c) => {
        const userId = await insertUser(c);
        expect(await tryInsertTx(c, userId, { kind: 'transfer', note })).toBeNull();
      });
    },
  );

  it('RF-M6-03 a transaction note of 141 characters is rejected', async () => {
    await inTx(async (c) => {
      const userId = await insertUser(c);
      expect(await tryInsertTx(c, userId, { kind: 'transfer', note: 'x'.repeat(141) })).toBe(
        STRING_TOO_LONG,
      );
    });
  });

  it('RF-M6-03 a shortcut note of 140 characters is accepted and one of 141 is rejected', async () => {
    await inTx(async (c) => {
      const userId = await insertUser(c);
      const acc = await insertAccount(c, userId);
      const cat = await insertCategory(c, userId);
      expect(
        await tryInsertShortcut(c, userId, {
          accountId: acc,
          categoryId: cat,
          note: 'x'.repeat(140),
        }),
      ).toBeNull();
      expect(
        await tryInsertShortcut(c, userId, {
          accountId: acc,
          categoryId: cat,
          note: 'x'.repeat(141),
        }),
      ).toBe(STRING_TOO_LONG);
    });
  });
});

describe('RF-M6-01 amounts', () => {
  it('RF-M6-01 a ledger entry with amount 0 violates the CHECK', async () => {
    await inTx(async (c) => {
      const userId = await insertUser(c);
      const acc = await insertAccount(c, userId);
      const tx = await insertTx(c, userId, { kind: 'adjustment' });
      expect(await tryInsertEntry(c, userId, tx, acc, '0.00')).toBe(CHECK_VIOLATION);
    });
  });

  it.each(['0.01', '-0.01', '999999999.99', '-999999999.99'])(
    'RF-M6-01 a ledger entry with the signed amount %s is accepted',
    async (amount) => {
      await inTx(async (c) => {
        const userId = await insertUser(c);
        const acc = await insertAccount(c, userId);
        const tx = await insertTx(c, userId, { kind: 'adjustment' });
        expect(await tryInsertEntry(c, userId, tx, acc, amount)).toBeNull();
      });
    },
  );

  it('RF-M6-01 a ledger entry keeps two decimals', async () => {
    await inTx(async (c) => {
      const userId = await insertUser(c);
      const acc = await insertAccount(c, userId);
      const tx = await insertTx(c, userId, { kind: 'adjustment' });
      expect(await tryInsertEntry(c, userId, tx, acc, '12.50')).toBeNull();
      const { rows } = await c.query<{ amount: string }>(
        `SELECT amount::text AS amount FROM ledger_entry WHERE transaction_id = $1`,
        [tx],
      );
      expect(rows[0]!.amount).toBe('12.50');
    });
  });

  it.each(['0.00', '1000000000.00', '-5.00'])(
    'RF-M6-01 a shortcut with amount %s violates the CHECK',
    async (amount) => {
      await inTx(async (c) => {
        const userId = await insertUser(c);
        const acc = await insertAccount(c, userId);
        const cat = await insertCategory(c, userId);
        expect(
          await tryInsertShortcut(c, userId, { accountId: acc, categoryId: cat, amount }),
        ).toBe(CHECK_VIOLATION);
      });
    },
  );

  it.each(['0.01', '999999999.99'])(
    'RF-M6-01 a shortcut with amount %s is accepted',
    async (amount) => {
      await inTx(async (c) => {
        const userId = await insertUser(c);
        const acc = await insertAccount(c, userId);
        const cat = await insertCategory(c, userId);
        expect(
          await tryInsertShortcut(c, userId, { accountId: acc, categoryId: cat, amount }),
        ).toBeNull();
      });
    },
  );
});

describe('TASK-016 ledger_entry', () => {
  it('TASK-016 deleting a transaction removes its entries', async () => {
    await inTx(async (c) => {
      const userId = await insertUser(c);
      const a = await insertAccount(c, userId, 'A');
      const b = await insertAccount(c, userId, 'B');
      const tx = await insertTx(c, userId, { kind: 'transfer' });
      expect(await tryInsertEntry(c, userId, tx, a, '-100.00')).toBeNull();
      expect(await tryInsertEntry(c, userId, tx, b, '100.00')).toBeNull();
      await c.query(`DELETE FROM ledger_transaction WHERE id = $1`, [tx]);
      const r = await c.query(`SELECT 1 FROM ledger_entry WHERE transaction_id = $1`, [tx]);
      expect(r.rowCount).toBe(0);
    });
  });

  it('TASK-016 an account with entries cannot be deleted', async () => {
    await inTx(async (c) => {
      const userId = await insertUser(c);
      const acc = await insertAccount(c, userId);
      const tx = await insertTx(c, userId, { kind: 'adjustment' });
      expect(await tryInsertEntry(c, userId, tx, acc, '10.00')).toBeNull();
      expect(await sqlState(c, `DELETE FROM account WHERE id = $1`, [acc])).toBe(FK_VIOLATION);
    });
  });

  it('TASK-016 an entry must point to an existing transaction', async () => {
    await inTx(async (c) => {
      const userId = await insertUser(c);
      const acc = await insertAccount(c, userId);
      expect(await tryInsertEntry(c, userId, randomUUID(), acc, '10.00')).toBe(FK_VIOLATION);
    });
  });
});

describe('RN-09 each user only references their own data', () => {
  it('RN-09 an entry that points to the account of another user violates the composite foreign key', async () => {
    await inTx(async (c) => {
      const a = await insertUser(c);
      const b = await insertUser(c);
      const accountOfB = await insertAccount(c, b);
      const txOfA = await insertTx(c, a, { kind: 'adjustment' });
      expect(await tryInsertEntry(c, a, txOfA, accountOfB, '10.00')).toBe(FK_VIOLATION);
    });
  });

  it('RN-09 a transaction with the category of another user violates the composite foreign key', async () => {
    await inTx(async (c) => {
      const a = await insertUser(c);
      const b = await insertUser(c);
      const categoryOfB = await insertCategory(c, b);
      expect(await tryInsertTx(c, a, { kind: 'expense', categoryId: categoryOfB })).toBe(
        FK_VIOLATION,
      );
    });
  });

  it('RN-09 a shortcut with the account of another user violates the composite foreign key', async () => {
    await inTx(async (c) => {
      const a = await insertUser(c);
      const b = await insertUser(c);
      const accountOfB = await insertAccount(c, b);
      const categoryOfA = await insertCategory(c, a);
      expect(
        await tryInsertShortcut(c, a, { accountId: accountOfB, categoryId: categoryOfA }),
      ).toBe(FK_VIOLATION);
    });
  });

  it('RN-09 a shortcut with the destination account of another user violates the composite foreign key', async () => {
    await inTx(async (c) => {
      const a = await insertUser(c);
      const b = await insertUser(c);
      const accountOfA = await insertAccount(c, a);
      const accountOfB = await insertAccount(c, b);
      expect(
        await tryInsertShortcut(c, a, {
          kind: 'transfer',
          accountId: accountOfA,
          destAccountId: accountOfB,
        }),
      ).toBe(FK_VIOLATION);
    });
  });

  it('RN-09 a shortcut with the category of another user violates the composite foreign key', async () => {
    await inTx(async (c) => {
      const a = await insertUser(c);
      const b = await insertUser(c);
      const accountOfA = await insertAccount(c, a);
      const categoryOfB = await insertCategory(c, b);
      expect(
        await tryInsertShortcut(c, a, { accountId: accountOfA, categoryId: categoryOfB }),
      ).toBe(FK_VIOLATION);
    });
  });

  it('RN-09 a fee may point to a parent transaction of the same user', async () => {
    await inTx(async (c) => {
      const a = await insertUser(c);
      const cat = await insertCategory(c, a);
      const parent = await insertTx(c, a, { kind: 'transfer' });
      expect(
        await tryInsertTx(c, a, { categoryId: cat, origin: 'fee', parentTransactionId: parent }),
      ).toBeNull();
    });
  });
});

describe('RF-M7-09 shortcut', () => {
  it('RF-M7-09 a transfer shortcut with origin and destination and no category is accepted', async () => {
    await inTx(async (c) => {
      const userId = await insertUser(c);
      const a = await insertAccount(c, userId, 'A');
      const b = await insertAccount(c, userId, 'B');
      expect(
        await tryInsertShortcut(c, userId, { kind: 'transfer', accountId: a, destAccountId: b }),
      ).toBeNull();
    });
  });

  it('RF-M7-09 a transfer shortcut without destination violates the CHECK', async () => {
    await inTx(async (c) => {
      const userId = await insertUser(c);
      const a = await insertAccount(c, userId);
      expect(
        await tryInsertShortcut(c, userId, { kind: 'transfer', accountId: a, destAccountId: null }),
      ).toBe(CHECK_VIOLATION);
    });
  });

  it('RF-M7-09 a transfer shortcut with category violates the CHECK', async () => {
    await inTx(async (c) => {
      const userId = await insertUser(c);
      const a = await insertAccount(c, userId, 'A');
      const b = await insertAccount(c, userId, 'B');
      const cat = await insertCategory(c, userId);
      expect(
        await tryInsertShortcut(c, userId, {
          kind: 'transfer',
          accountId: a,
          destAccountId: b,
          categoryId: cat,
        }),
      ).toBe(CHECK_VIOLATION);
    });
  });

  it.each(['expense', 'income'] as const)(
    'RF-M7-09 a %s shortcut with category and without destination is accepted',
    async (kind) => {
      await inTx(async (c) => {
        const userId = await insertUser(c);
        const a = await insertAccount(c, userId);
        const cat = await insertCategory(c, userId, kind);
        expect(
          await tryInsertShortcut(c, userId, { kind, accountId: a, categoryId: cat }),
        ).toBeNull();
      });
    },
  );

  it.each(['expense', 'income'] as const)(
    'RF-M7-09 a %s shortcut without category violates the CHECK',
    async (kind) => {
      await inTx(async (c) => {
        const userId = await insertUser(c);
        const a = await insertAccount(c, userId);
        expect(await tryInsertShortcut(c, userId, { kind, accountId: a, categoryId: null })).toBe(
          CHECK_VIOLATION,
        );
      });
    },
  );

  it.each(['expense', 'income'] as const)(
    'RF-M7-09 a %s shortcut with destination violates the CHECK',
    async (kind) => {
      await inTx(async (c) => {
        const userId = await insertUser(c);
        const a = await insertAccount(c, userId, 'A');
        const b = await insertAccount(c, userId, 'B');
        const cat = await insertCategory(c, userId, kind);
        expect(
          await tryInsertShortcut(c, userId, {
            kind,
            accountId: a,
            destAccountId: b,
            categoryId: cat,
          }),
        ).toBe(CHECK_VIOLATION);
      });
    },
  );

  it('RF-M7-09 the account of a shortcut is required', async () => {
    await inTx(async (c) => {
      const userId = await insertUser(c);
      const cat = await insertCategory(c, userId);
      expect(
        await sqlState(
          c,
          `INSERT INTO shortcut (id, user_id, name, kind, category_id, sort_order)
           VALUES ($1, $2, 'Almuerzo', 'expense', $3, 0)`,
          [randomUUID(), userId, cat],
        ),
      ).toBe(NOT_NULL_VIOLATION);
    });
  });

  it('RF-M7-09 the amount of a shortcut is optional', async () => {
    await inTx(async (c) => {
      const userId = await insertUser(c);
      const a = await insertAccount(c, userId);
      const cat = await insertCategory(c, userId);
      expect(
        await tryInsertShortcut(c, userId, { accountId: a, categoryId: cat, amount: null }),
      ).toBeNull();
    });
  });

  it.each([
    ['', CHECK_VIOLATION],
    [' Almuerzo', CHECK_VIOLATION],
    ['Almuerzo ', CHECK_VIOLATION],
    ['x'.repeat(31), STRING_TOO_LONG],
  ])('RF-M7-09 the shortcut name %j is rejected', async (name, state) => {
    await inTx(async (c) => {
      const userId = await insertUser(c);
      const a = await insertAccount(c, userId);
      const cat = await insertCategory(c, userId);
      expect(await tryInsertShortcut(c, userId, { name, accountId: a, categoryId: cat })).toBe(
        state,
      );
    });
  });

  it.each(['A', 'x'.repeat(30)])('RF-M7-09 the shortcut name %j is accepted', async (name) => {
    await inTx(async (c) => {
      const userId = await insertUser(c);
      const a = await insertAccount(c, userId);
      const cat = await insertCategory(c, userId);
      expect(
        await tryInsertShortcut(c, userId, { name, accountId: a, categoryId: cat }),
      ).toBeNull();
    });
  });

  it('RF-M7-09 deleting the account of a shortcut removes the shortcut', async () => {
    await inTx(async (c) => {
      const userId = await insertUser(c);
      const a = await insertAccount(c, userId);
      const cat = await insertCategory(c, userId);
      expect(await tryInsertShortcut(c, userId, { accountId: a, categoryId: cat })).toBeNull();
      await c.query(`DELETE FROM account WHERE id = $1`, [a]);
      const r = await c.query(`SELECT 1 FROM shortcut WHERE user_id = $1`, [userId]);
      expect(r.rowCount).toBe(0);
    });
  });
});

describe('TASK-016 undo_action', () => {
  it('TASK-016 an undo action is stored with its payload and is not consumed by default', async () => {
    await inTx(async (c) => {
      const userId = await insertUser(c);
      const id = randomUUID();
      await c.query(
        `INSERT INTO undo_action (id, user_id, kind, payload, expires_at)
         VALUES ($1, $2, 'delete', $3::jsonb, now() + interval '12 seconds')`,
        [id, userId, JSON.stringify({ ids: [randomUUID()] })],
      );
      const { rows } = await c.query(
        `SELECT kind::text AS kind, consumed_at FROM undo_action WHERE id = $1`,
        [id],
      );
      expect(rows[0]).toEqual({ kind: 'delete', consumed_at: null });
    });
  });

  it('TASK-016 the payload of an undo action is required', async () => {
    await inTx(async (c) => {
      const userId = await insertUser(c);
      expect(
        await sqlState(
          c,
          `INSERT INTO undo_action (id, user_id, kind, expires_at)
           VALUES ($1, $2, 'delete', now() + interval '12 seconds')`,
          [randomUUID(), userId],
        ),
      ).toBe(NOT_NULL_VIOLATION);
    });
  });

  it('TASK-016 deleting the user removes its undo actions and shortcuts', async () => {
    await inTx(async (c) => {
      const userId = await insertUser(c);
      const a = await insertAccount(c, userId);
      const cat = await insertCategory(c, userId);
      expect(await tryInsertShortcut(c, userId, { accountId: a, categoryId: cat })).toBeNull();
      await c.query(
        `INSERT INTO undo_action (id, user_id, kind, payload, expires_at)
         VALUES ($1, $2, 'create', '{}'::jsonb, now() + interval '12 seconds')`,
        [randomUUID(), userId],
      );
      await c.query(`DELETE FROM auth_user WHERE id = $1`, [userId]);
      const u = await c.query(`SELECT 1 FROM undo_action WHERE user_id = $1`, [userId]);
      const s = await c.query(`SELECT 1 FROM shortcut WHERE user_id = $1`, [userId]);
      expect(u.rowCount).toBe(0);
      expect(s.rowCount).toBe(0);
    });
  });
});
