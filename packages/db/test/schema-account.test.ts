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
async function userWithCurrencies(c: pg.PoolClient): Promise<string> {
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

interface AccountInput {
  id?: string;
  type?: string;
  name?: string;
  currency?: string;
  initialBalance?: string | null;
  initialBalanceDate?: string;
  cardCutDay?: number | null;
  cardPayDay?: number | null;
  cardLimit?: string | null;
  status?: 'active' | 'archived';
  archivedAt?: string | null;
  sortOrder?: number;
}

const INSERT_ACCOUNT = `INSERT INTO account (id, user_id, type, name, currency_code, initial_balance,
                          initial_balance_date, color, icon, card_cut_day, card_pay_day, card_limit,
                          status, archived_at, sort_order)
                        VALUES ($1, $2, $3, $4, $5, COALESCE($6::numeric, 0), $7, '#22c55e', 'wallet',
                          $8, $9, $10, $11, $12, $13)`;

function accountValues(userId: string, a: AccountInput): unknown[] {
  const status = a.status ?? 'active';
  return [
    a.id ?? randomUUID(),
    userId,
    a.type ?? 'bank',
    a.name ?? 'Cuenta',
    a.currency ?? 'BOB',
    a.initialBalance ?? null,
    a.initialBalanceDate ?? '2026-01-01',
    a.cardCutDay ?? null,
    a.cardPayDay ?? null,
    a.cardLimit ?? null,
    status,
    a.archivedAt !== undefined
      ? a.archivedAt
      : status === 'archived'
        ? new Date().toISOString()
        : null,
    a.sortOrder ?? 0,
  ];
}

function tryInsertAccount(
  c: pg.PoolClient,
  userId: string,
  a: AccountInput = {},
): Promise<string | null> {
  return sqlState(c, INSERT_ACCOUNT, accountValues(userId, a));
}

async function insertAccount(
  c: pg.PoolClient,
  userId: string,
  a: AccountInput = {},
): Promise<string> {
  const id = a.id ?? randomUUID();
  await c.query(INSERT_ACCOUNT, accountValues(userId, { ...a, id }));
  return id;
}

describe('TASK-014 account table, indexes and trigger exist', () => {
  it('TASK-014 the table account exists', async () => {
    const { rows } = await sql().query<{ reg: string | null }>(
      `SELECT to_regclass('public.account')::text AS reg`,
    );
    expect(rows[0]!.reg).toBe('account');
  });

  it('TASK-014 schema.prisma declares a model mapped to account', () => {
    const path = fileURLToPath(new URL('../prisma/schema.prisma', import.meta.url));
    const source = readFileSync(path, 'utf8');
    const models = [...source.matchAll(/^\s*model\s+\w+\s*\{([^}]*)\}/gm)];
    const mapped = models.filter(([, body]) => /@@map\(\s*"account"\s*\)/.test(body!));
    expect(mapped).toHaveLength(1);
  });

  it('TASK-014 the unique partial index account_active_name exists on (user_id, lower(name))', async () => {
    const { rows } = await sql().query<{ indexdef: string }>(
      `SELECT indexdef FROM pg_indexes WHERE schemaname = 'public' AND tablename = 'account'
          AND indexname = 'account_active_name'`,
    );
    expect(rows).toHaveLength(1);
    const def = rows[0]!.indexdef;
    expect(def).toMatch(/UNIQUE INDEX/);
    expect(def).toMatch(/\(user_id, lower\(\(name\)::text\)\)/);
    expect(def).toMatch(/WHERE \(status = 'active'::lifecycle_status\)/);
  });

  it('TASK-014 an index on (user_id, status, sort_order) exists', async () => {
    const { rows } = await sql().query<{ indexdef: string }>(
      `SELECT indexdef FROM pg_indexes WHERE schemaname = 'public' AND tablename = 'account'`,
    );
    expect(rows.some((r) => /\(user_id, status, sort_order\)/.test(r.indexdef))).toBe(true);
  });

  it('TASK-014 the BEFORE UPDATE trigger account_initial_immutable exists', async () => {
    const { rows } = await sql().query<{ tgtype: number }>(
      `SELECT tgtype FROM pg_trigger
        WHERE tgrelid = 'public.account'::regclass AND tgname = 'account_initial_immutable'
          AND NOT tgisinternal`,
    );
    expect(rows).toHaveLength(1);
    const tgtype = rows[0]!.tgtype;
    // bit 1 (2) = BEFORE, bit 4 (16) = UPDATE
    expect(tgtype & 2).toBe(2);
    expect(tgtype & 16).toBe(16);
  });

  it('TASK-014 a minimal account takes the defaults initial_balance 0 and status active', async () => {
    await inTx(async (c) => {
      const userId = await userWithCurrencies(c);
      const id = randomUUID();
      await c.query(
        `INSERT INTO account (id, user_id, type, name, currency_code, initial_balance_date, color, icon, sort_order)
         VALUES ($1, $2, 'cash', 'Efectivo', 'BOB', '2026-01-01', '#000000', 'cash', 0)`,
        [id, userId],
      );
      const { rows } = await c.query(
        `SELECT initial_balance::text AS initial_balance, status::text AS status, archived_at
           FROM account WHERE id = $1`,
        [id],
      );
      expect(rows[0]).toEqual({ initial_balance: '0.00', status: 'active', archived_at: null });
    });
  });

  it('TASK-014 the currency must be one of the user currencies', async () => {
    await inTx(async (c) => {
      const userId = await userWithCurrencies(c);
      expect(await tryInsertAccount(c, userId, { currency: 'EUR' })).toBe(FK_VIOLATION);
      expect(await tryInsertAccount(c, userId, { currency: 'USD' })).toBeNull();
    });
  });

  it('TASK-014 status archived requires archived_at and vice versa', async () => {
    await inTx(async (c) => {
      const userId = await userWithCurrencies(c);
      expect(await tryInsertAccount(c, userId, { status: 'archived', archivedAt: null })).toBe(
        CHECK_VIOLATION,
      );
      expect(
        await tryInsertAccount(c, userId, {
          status: 'active',
          archivedAt: new Date().toISOString(),
        }),
      ).toBe(CHECK_VIOLATION);
      expect(await tryInsertAccount(c, userId, { status: 'archived' })).toBeNull();
    });
  });

  it('TASK-014 deleting the user removes its accounts', async () => {
    await inTx(async (c) => {
      const userId = await userWithCurrencies(c);
      await insertAccount(c, userId);
      await c.query(`DELETE FROM auth_user WHERE id = $1`, [userId]);
      const r = await c.query(`SELECT 1 FROM account WHERE user_id = $1`, [userId]);
      expect(r.rowCount).toBe(0);
    });
  });
});

describe('RF-M4-01 account name', () => {
  it('RF-M4-01 two active accounts with the same name ignoring case violate the index', async () => {
    await inTx(async (c) => {
      const userId = await userWithCurrencies(c);
      expect(await tryInsertAccount(c, userId, { name: 'Banco Union' })).toBeNull();
      expect(await tryInsertAccount(c, userId, { name: 'BANCO union' })).toBe(UNIQUE_VIOLATION);
    });
  });

  it('RF-M4-01 an archived account does not block an active one with the same name', async () => {
    await inTx(async (c) => {
      const userId = await userWithCurrencies(c);
      expect(await tryInsertAccount(c, userId, { name: 'Ahorros', status: 'archived' })).toBeNull();
      expect(await tryInsertAccount(c, userId, { name: 'ahorros' })).toBeNull();
      expect(await tryInsertAccount(c, userId, { name: 'AHORROS', status: 'archived' })).toBeNull();
    });
  });

  it('RF-M4-01 two users can each have an active account with the same name', async () => {
    await inTx(async (c) => {
      const a = await userWithCurrencies(c);
      const b = await userWithCurrencies(c);
      expect(await tryInsertAccount(c, a, { name: 'Billetera' })).toBeNull();
      expect(await tryInsertAccount(c, b, { name: 'Billetera' })).toBeNull();
    });
  });

  it('RF-M4-01 unarchiving an account whose name is taken by an active one violates the index', async () => {
    await inTx(async (c) => {
      const userId = await userWithCurrencies(c);
      const archived = await insertAccount(c, userId, { name: 'Caja', status: 'archived' });
      await insertAccount(c, userId, { name: 'caja' });
      expect(
        await sqlState(
          c,
          `UPDATE account SET status = 'active', archived_at = NULL WHERE id = $1`,
          [archived],
        ),
      ).toBe(UNIQUE_VIOLATION);
    });
  });

  it.each([
    ['', CHECK_VIOLATION],
    [' Banco', CHECK_VIOLATION],
    ['Banco ', CHECK_VIOLATION],
    ['x'.repeat(41), STRING_TOO_LONG],
  ])('RF-M4-01 the name %j is rejected', async (name, state) => {
    await inTx(async (c) => {
      const userId = await userWithCurrencies(c);
      expect(await tryInsertAccount(c, userId, { name })).toBe(state);
    });
  });

  it.each(['A', 'x'.repeat(40)])('RF-M4-01 the name %j is accepted', async (name) => {
    await inTx(async (c) => {
      const userId = await userWithCurrencies(c);
      expect(await tryInsertAccount(c, userId, { name })).toBeNull();
    });
  });
});

describe('RF-M4-02 initial balance by type', () => {
  it.each(['cash', 'ewallet'])(
    'RF-M4-02 %s with a negative initial balance violates the CHECK',
    async (type) => {
      await inTx(async (c) => {
        const userId = await userWithCurrencies(c);
        expect(await tryInsertAccount(c, userId, { type, initialBalance: '-0.01' })).toBe(
          CHECK_VIOLATION,
        );
      });
    },
  );

  it.each(['cash', 'ewallet'])(
    'RF-M4-02 %s with an initial balance of 0 or more is accepted',
    async (type) => {
      await inTx(async (c) => {
        const userId = await userWithCurrencies(c);
        expect(
          await tryInsertAccount(c, userId, { type, name: 'Cero', initialBalance: '0.00' }),
        ).toBeNull();
        expect(
          await tryInsertAccount(c, userId, { type, name: 'Positivo', initialBalance: '150.50' }),
        ).toBeNull();
      });
    },
  );

  it.each(['credit_card', 'bank', 'savings', 'other'])(
    'RF-M4-02 %s accepts a negative or positive initial balance',
    async (type) => {
      await inTx(async (c) => {
        const userId = await userWithCurrencies(c);
        expect(
          await tryInsertAccount(c, userId, { type, name: 'Deuda', initialBalance: '-1200.00' }),
        ).toBeNull();
        expect(
          await tryInsertAccount(c, userId, { type, name: 'A favor', initialBalance: '300.00' }),
        ).toBeNull();
      });
    },
  );

  it.each(['999999999.99', '-999999999.99'])(
    'RF-M4-02 an initial balance of %s is accepted',
    async (initialBalance) => {
      await inTx(async (c) => {
        const userId = await userWithCurrencies(c);
        expect(await tryInsertAccount(c, userId, { type: 'bank', initialBalance })).toBeNull();
      });
    },
  );

  it.each(['1000000000.00', '-1000000000.00'])(
    'RF-M4-02 an initial balance of %s exceeds the maximum',
    async (initialBalance) => {
      await inTx(async (c) => {
        const userId = await userWithCurrencies(c);
        expect(await tryInsertAccount(c, userId, { type: 'bank', initialBalance })).toBe(
          CHECK_VIOLATION,
        );
      });
    },
  );

  it('RF-M4-02 initial_balance is numeric(14,2)', async () => {
    const { rows } = await sql().query(
      `SELECT data_type, numeric_precision, numeric_scale FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'account' AND column_name = 'initial_balance'`,
    );
    expect(rows).toEqual([{ data_type: 'numeric', numeric_precision: 14, numeric_scale: 2 }]);
  });

  it('RF-M4-02 a bank account with a negative initial balance cannot become cash', async () => {
    await inTx(async (c) => {
      const userId = await userWithCurrencies(c);
      const id = await insertAccount(c, userId, { type: 'bank', initialBalance: '-50.00' });
      expect(await sqlState(c, `UPDATE account SET type = 'cash' WHERE id = $1`, [id])).toBe(
        CHECK_VIOLATION,
      );
    });
  });
});

describe('RF-M4-07 initial balance and its date are immutable', () => {
  it('RF-M4-07 updating initial_balance fails', async () => {
    await inTx(async (c) => {
      const userId = await userWithCurrencies(c);
      const id = await insertAccount(c, userId, { initialBalance: '100.00' });
      expect(
        await sqlState(c, `UPDATE account SET initial_balance = 200.00 WHERE id = $1`, [id]),
      ).not.toBeNull();
      const { rows } = await c.query<{ v: string }>(
        `SELECT initial_balance::text AS v FROM account WHERE id = $1`,
        [id],
      );
      expect(rows[0]!.v).toBe('100.00');
    });
  });

  it('RF-M4-07 updating initial_balance_date fails', async () => {
    await inTx(async (c) => {
      const userId = await userWithCurrencies(c);
      const id = await insertAccount(c, userId, { initialBalanceDate: '2026-01-01' });
      expect(
        await sqlState(c, `UPDATE account SET initial_balance_date = '2026-02-01' WHERE id = $1`, [
          id,
        ]),
      ).not.toBeNull();
      const { rows } = await c.query<{ d: string }>(
        `SELECT initial_balance_date::text AS d FROM account WHERE id = $1`,
        [id],
      );
      expect(rows[0]!.d).toBe('2026-01-01');
    });
  });

  it('RF-M4-07 name, color and icon can be edited', async () => {
    await inTx(async (c) => {
      const userId = await userWithCurrencies(c);
      const id = await insertAccount(c, userId, { initialBalance: '100.00' });
      expect(
        await sqlState(
          c,
          `UPDATE account SET name = 'Nuevo nombre', color = '#ef4444', icon = 'bank' WHERE id = $1`,
          [id],
        ),
      ).toBeNull();
    });
  });

  it('RF-M4-07 the type can change when the initial balance fits the new type', async () => {
    await inTx(async (c) => {
      const userId = await userWithCurrencies(c);
      const id = await insertAccount(c, userId, { type: 'bank', initialBalance: '100.00' });
      expect(await sqlState(c, `UPDATE account SET type = 'cash' WHERE id = $1`, [id])).toBeNull();
    });
  });

  it('RF-M4-07 a card that stops being a card must clear cut day, pay day and limit', async () => {
    await inTx(async (c) => {
      const userId = await userWithCurrencies(c);
      const id = await insertAccount(c, userId, {
        type: 'credit_card',
        cardCutDay: 15,
        cardPayDay: 5,
        cardLimit: '5000.00',
      });
      expect(await sqlState(c, `UPDATE account SET type = 'bank' WHERE id = $1`, [id])).toBe(
        CHECK_VIOLATION,
      );
      expect(
        await sqlState(
          c,
          `UPDATE account SET type = 'bank', card_cut_day = NULL, card_pay_day = NULL, card_limit = NULL
            WHERE id = $1`,
          [id],
        ),
      ).toBeNull();
    });
  });
});

describe('EC-M4-02 the initial balance is not editable', () => {
  it('EC-M4-02 correcting the initial balance of an account with an UPDATE fails', async () => {
    await inTx(async (c) => {
      const userId = await userWithCurrencies(c);
      const id = await insertAccount(c, userId, { type: 'cash', initialBalance: '80.00' });
      expect(
        await sqlState(c, `UPDATE account SET initial_balance = 95.00 WHERE id = $1`, [id]),
      ).not.toBeNull();
    });
  });

  it('EC-M4-02 changing the initial balance together with editable fields also fails', async () => {
    await inTx(async (c) => {
      const userId = await userWithCurrencies(c);
      const id = await insertAccount(c, userId, { initialBalance: '80.00' });
      expect(
        await sqlState(
          c,
          `UPDATE account SET name = 'Otro', initial_balance_date = '2025-12-31' WHERE id = $1`,
          [id],
        ),
      ).not.toBeNull();
      const { rows } = await c.query<{ name: string }>(`SELECT name FROM account WHERE id = $1`, [
        id,
      ]);
      expect(rows[0]!.name).toBe('Cuenta');
    });
  });
});

describe('TASK-014 card fields are only accepted in credit_card', () => {
  it('TASK-014 a credit_card accepts cut day, pay day and limit', async () => {
    await inTx(async (c) => {
      const userId = await userWithCurrencies(c);
      expect(
        await tryInsertAccount(c, userId, {
          type: 'credit_card',
          cardCutDay: 31,
          cardPayDay: 1,
          cardLimit: '10000.00',
        }),
      ).toBeNull();
    });
  });

  it.each(['cash', 'bank', 'ewallet', 'savings', 'other'])(
    'TASK-014 a %s account with card fields violates the CHECK',
    async (type) => {
      await inTx(async (c) => {
        const userId = await userWithCurrencies(c);
        expect(await tryInsertAccount(c, userId, { type, cardCutDay: 10 })).toBe(CHECK_VIOLATION);
        expect(await tryInsertAccount(c, userId, { type, cardPayDay: 10 })).toBe(CHECK_VIOLATION);
        expect(await tryInsertAccount(c, userId, { type, cardLimit: '1000.00' })).toBe(
          CHECK_VIOLATION,
        );
      });
    },
  );

  it.each([
    ['card_cut_day 0', { cardCutDay: 0 }],
    ['card_cut_day 32', { cardCutDay: 32 }],
    ['card_pay_day 0', { cardPayDay: 0 }],
    ['card_pay_day 32', { cardPayDay: 32 }],
    ['card_limit 0', { cardLimit: '0.00' }],
    ['card_limit negative', { cardLimit: '-10.00' }],
  ] as const)('TASK-014 a credit_card with %s violates the CHECK', async (_label, fields) => {
    await inTx(async (c) => {
      const userId = await userWithCurrencies(c);
      expect(await tryInsertAccount(c, userId, { type: 'credit_card', ...fields })).toBe(
        CHECK_VIOLATION,
      );
    });
  });
});
