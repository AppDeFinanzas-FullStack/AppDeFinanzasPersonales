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

async function insertAccount(c: pg.PoolClient, userId: string, name = 'Ahorro'): Promise<string> {
  const id = randomUUID();
  await c.query(
    `INSERT INTO account (id, user_id, type, name, currency_code, initial_balance_date,
                          color, icon, sort_order)
     VALUES ($1, $2, 'savings', $3, 'BOB', '2026-01-01', '#22c55e', 'wallet', 0)`,
    [id, userId, name],
  );
  return id;
}

interface GoalInput {
  id?: string;
  name?: string;
  target?: string;
  dedicatedAccountId?: string | null;
  archivedAt?: string | null;
}

const INSERT_GOAL = `INSERT INTO goal (id, user_id, name, target, currency_code, icon, color,
                       dedicated_account_id, archived_at)
                     VALUES ($1, $2, $3, $4, 'BOB', 'piggy-bank', '#22c55e', $5, $6)`;

function goalValues(userId: string, a: GoalInput): unknown[] {
  return [
    a.id ?? randomUUID(),
    userId,
    a.name ?? 'Viaje',
    a.target ?? '5000.00',
    a.dedicatedAccountId ?? null,
    a.archivedAt ?? null,
  ];
}

function tryInsertGoal(c: pg.PoolClient, userId: string, a: GoalInput = {}): Promise<string | null> {
  return sqlState(c, INSERT_GOAL, goalValues(userId, a));
}

async function insertGoal(c: pg.PoolClient, userId: string, a: GoalInput = {}): Promise<string> {
  const id = a.id ?? randomUUID();
  await c.query(INSERT_GOAL, goalValues(userId, { ...a, id }));
  return id;
}

interface DebtInput {
  id?: string;
  person?: string;
  principal?: string;
  interestRate?: string | null;
  interestPeriod?: 'monthly' | 'yearly' | null;
  interestUnpaid?: string;
  capitalOutstanding?: string;
}

const INSERT_DEBT = `INSERT INTO debt (id, user_id, direction, person, person_key, principal,
                       currency_code, start_date, interest_rate, interest_period,
                       capital_outstanding, interest_unpaid, accrued_through)
                     VALUES ($1, $2, 'i_owe', $3::varchar, lower($3::varchar), $4, 'BOB', '2026-01-01', $5, $6,
                       $7, $8, '2026-01-01')`;

function debtValues(userId: string, a: DebtInput): unknown[] {
  const principal = a.principal ?? '1000.00';
  return [
    a.id ?? randomUUID(),
    userId,
    a.person ?? 'Juan',
    principal,
    a.interestRate === undefined ? null : a.interestRate,
    a.interestPeriod === undefined ? null : a.interestPeriod,
    a.capitalOutstanding ?? principal,
    a.interestUnpaid ?? '0',
  ];
}

function tryInsertDebt(c: pg.PoolClient, userId: string, a: DebtInput = {}): Promise<string | null> {
  return sqlState(c, INSERT_DEBT, debtValues(userId, a));
}

async function insertDebt(c: pg.PoolClient, userId: string, a: DebtInput = {}): Promise<string> {
  const id = a.id ?? randomUUID();
  await c.query(INSERT_DEBT, debtValues(userId, { ...a, id }));
  return id;
}

const INSERT_PAYMENT = `INSERT INTO debt_payment (id, user_id, debt_id, amount, interest_part,
                          capital_part, date)
                        VALUES ($1, $2, $3, $4, $5, $6, '2026-02-01')`;

function tryInsertPayment(
  c: pg.PoolClient,
  userId: string,
  debtId: string,
  amount: string,
  interestPart: string,
  capitalPart: string,
): Promise<string | null> {
  return sqlState(c, INSERT_PAYMENT, [
    randomUUID(),
    userId,
    debtId,
    amount,
    interestPart,
    capitalPart,
  ]);
}

describe('TASK-018 goal and debt tables exist', () => {
  const tables = ['goal', 'goal_allocation_event', 'debt', 'debt_payment'];

  it.each(tables)('TASK-018 the table %s exists', async (table) => {
    const { rows } = await sql().query<{ reg: string | null }>(
      `SELECT to_regclass('public.' || $1)::text AS reg`,
      [table],
    );
    expect(rows[0]!.reg).toBe(table);
  });

  it.each(tables)('TASK-018 schema.prisma declares a model mapped to %s', (table) => {
    const path = fileURLToPath(new URL('../prisma/schema.prisma', import.meta.url));
    const source = readFileSync(path, 'utf8');
    const models = [...source.matchAll(/^\s*model\s+\w+\s*\{([^}]*)\}/gm)];
    const re = new RegExp(`@@map\\(\\s*"${table}"\\s*\\)`);
    const mapped = models.filter(([, body]) => re.test(body!));
    expect(mapped).toHaveLength(1);
  });

  it('TASK-018 a goal_allocation_event links a goal and an account and rejects amount 0', async () => {
    await inTx(async (c) => {
      const userId = await insertUser(c);
      const acc = await insertAccount(c, userId);
      const goalId = await insertGoal(c, userId);
      const insert = `INSERT INTO goal_allocation_event (id, user_id, goal_id, account_id, amount, origin)
                      VALUES ($1, $2, $3, $4, $5, 'manual')`;
      expect(await sqlState(c, insert, [randomUUID(), userId, goalId, acc, '100.00'])).toBeNull();
      expect(await sqlState(c, insert, [randomUUID(), userId, goalId, acc, '-40.00'])).toBeNull();
      expect(await sqlState(c, insert, [randomUUID(), userId, goalId, acc, '0.00'])).toBe(
        CHECK_VIOLATION,
      );
    });
  });
});

describe('RF-M12-01 goal name of 1 to 40 characters and target greater than 0', () => {
  it('RF-M12-01 a goal with valid name and target is accepted', async () => {
    await inTx(async (c) => {
      const userId = await insertUser(c);
      expect(await tryInsertGoal(c, userId, { name: 'x'.repeat(40), target: '0.01' })).toBeNull();
    });
  });

  it.each(['', ' Viaje', 'Viaje '])('RF-M12-01 the name "%s" violates the CHECK', async (name) => {
    await inTx(async (c) => {
      const userId = await insertUser(c);
      expect(await tryInsertGoal(c, userId, { name })).toBe(CHECK_VIOLATION);
    });
  });

  it('RF-M12-01 a name of 41 characters is rejected', async () => {
    await inTx(async (c) => {
      const userId = await insertUser(c);
      expect(await tryInsertGoal(c, userId, { name: 'x'.repeat(41) })).toBe(STRING_TOO_LONG);
    });
  });

  it.each(['0.00', '-1.00'])('RF-M12-01 target %s violates the CHECK', async (target) => {
    await inTx(async (c) => {
      const userId = await insertUser(c);
      expect(await tryInsertGoal(c, userId, { target })).toBe(CHECK_VIOLATION);
    });
  });
});

describe('RF-M12-03 a dedicated account belongs to a single goal', () => {
  it('RF-M12-03 an account cannot be dedicated to two goals', async () => {
    await inTx(async (c) => {
      const userId = await insertUser(c);
      const acc = await insertAccount(c, userId);
      await insertGoal(c, userId, { name: 'Viaje', dedicatedAccountId: acc });
      expect(await tryInsertGoal(c, userId, { name: 'Auto', dedicatedAccountId: acc })).toBe(
        UNIQUE_VIOLATION,
      );
    });
  });

  it('RF-M12-03 two goals can each have their own dedicated account', async () => {
    await inTx(async (c) => {
      const userId = await insertUser(c);
      const a1 = await insertAccount(c, userId, 'Ahorro 1');
      const a2 = await insertAccount(c, userId, 'Ahorro 2');
      await insertGoal(c, userId, { name: 'Viaje', dedicatedAccountId: a1 });
      expect(await tryInsertGoal(c, userId, { name: 'Auto', dedicatedAccountId: a2 })).toBeNull();
    });
  });

  it('RF-M12-03 several goals without a dedicated account coexist', async () => {
    await inTx(async (c) => {
      const userId = await insertUser(c);
      await insertGoal(c, userId, { name: 'Viaje' });
      expect(await tryInsertGoal(c, userId, { name: 'Auto' })).toBeNull();
    });
  });

  it('RF-M12-03 an archived goal cannot have a dedicated account', async () => {
    await inTx(async (c) => {
      const userId = await insertUser(c);
      const acc = await insertAccount(c, userId);
      expect(
        await tryInsertGoal(c, userId, { dedicatedAccountId: acc, archivedAt: '2026-03-01T00:00:00Z' }),
      ).toBe(CHECK_VIOLATION);
    });
  });

  it('RF-M12-03 archiving a goal that keeps its dedicated account violates the CHECK', async () => {
    await inTx(async (c) => {
      const userId = await insertUser(c);
      const acc = await insertAccount(c, userId);
      const goalId = await insertGoal(c, userId, { dedicatedAccountId: acc });
      expect(await sqlState(c, `UPDATE goal SET archived_at = now() WHERE id = $1`, [goalId])).toBe(
        CHECK_VIOLATION,
      );
      expect(
        await sqlState(
          c,
          `UPDATE goal SET archived_at = now(), dedicated_account_id = NULL WHERE id = $1`,
          [goalId],
        ),
      ).toBeNull();
    });
  });

  it('RF-M12-03 an archived goal without a dedicated account is accepted', async () => {
    await inTx(async (c) => {
      const userId = await insertUser(c);
      expect(await tryInsertGoal(c, userId, { archivedAt: '2026-03-01T00:00:00Z' })).toBeNull();
    });
  });

  it('RF-M12-03 the dedicated account must belong to the same user', async () => {
    await inTx(async (c) => {
      const ana = await insertUser(c);
      const beto = await insertUser(c);
      const betoAcc = await insertAccount(c, beto);
      expect(await tryInsertGoal(c, ana, { dedicatedAccountId: betoAcc })).toBe('23503');
    });
  });
});

describe('RF-M13-01 debt person, principal and interest rate', () => {
  it.each(['0.0099', '0', '-1', '100.0001', '150'])(
    'RF-M13-01 interest_rate %s out of 0.01-100 violates the CHECK',
    async (rate) => {
      await inTx(async (c) => {
        const userId = await insertUser(c);
        expect(
          await tryInsertDebt(c, userId, { interestRate: rate, interestPeriod: 'monthly' }),
        ).toBe(CHECK_VIOLATION);
      });
    },
  );

  it.each(['0.01', '5.5', '100'])('RF-M13-01 interest_rate %s is accepted', async (rate) => {
    await inTx(async (c) => {
      const userId = await insertUser(c);
      expect(
        await tryInsertDebt(c, userId, { interestRate: rate, interestPeriod: 'yearly' }),
      ).toBeNull();
    });
  });

  it('RF-M13-01 a debt without interest is accepted', async () => {
    await inTx(async (c) => {
      const userId = await insertUser(c);
      expect(await tryInsertDebt(c, userId)).toBeNull();
    });
  });

  it('RF-M13-01 an interest rate without a period, or a period without a rate, violates the CHECK', async () => {
    await inTx(async (c) => {
      const userId = await insertUser(c);
      expect(await tryInsertDebt(c, userId, { interestRate: '5', interestPeriod: null })).toBe(
        CHECK_VIOLATION,
      );
      expect(await tryInsertDebt(c, userId, { interestRate: null, interestPeriod: 'monthly' })).toBe(
        CHECK_VIOLATION,
      );
    });
  });

  it.each(['0.00', '-10.00'])('RF-M13-01 principal %s violates the CHECK', async (principal) => {
    await inTx(async (c) => {
      const userId = await insertUser(c);
      expect(
        await tryInsertDebt(c, userId, { principal, capitalOutstanding: '0.00' }),
      ).toBe(CHECK_VIOLATION);
    });
  });

  it.each(['', ' Juan', 'Juan '])('RF-M13-01 the person "%s" violates the CHECK', async (person) => {
    await inTx(async (c) => {
      const userId = await insertUser(c);
      expect(await tryInsertDebt(c, userId, { person })).toBe(CHECK_VIOLATION);
    });
  });

  it('RF-M13-01 a person of 40 characters is accepted and one of 41 is rejected', async () => {
    await inTx(async (c) => {
      const userId = await insertUser(c);
      expect(await tryInsertDebt(c, userId, { person: 'x'.repeat(40) })).toBeNull();
      expect(await tryInsertDebt(c, userId, { person: 'x'.repeat(41) })).toBe(STRING_TOO_LONG);
    });
  });
});

describe('RF-M13-05 a payment satisfies interest + capital = amount', () => {
  it('RF-M13-05 a payment whose parts add up to the amount is accepted', async () => {
    await inTx(async (c) => {
      const userId = await insertUser(c);
      const debtId = await insertDebt(c, userId);
      expect(await tryInsertPayment(c, userId, debtId, '150.00', '50.00', '100.00')).toBeNull();
      expect(await tryInsertPayment(c, userId, debtId, '100.00', '0.00', '100.00')).toBeNull();
    });
  });

  it.each([
    ['150.00', '50.00', '99.99'],
    ['150.00', '50.01', '100.00'],
    ['100.00', '0.00', '0.00'],
    ['100.00', '60.00', '60.00'],
  ])(
    'RF-M13-05 amount %s with interest_part %s and capital_part %s violates the CHECK',
    async (amount, interest, capital) => {
      await inTx(async (c) => {
        const userId = await insertUser(c);
        const debtId = await insertDebt(c, userId);
        expect(await tryInsertPayment(c, userId, debtId, amount, interest, capital)).toBe(
          CHECK_VIOLATION,
        );
      });
    },
  );

  it('RF-M13-05 negative parts and a zero amount violate the CHECK', async () => {
    await inTx(async (c) => {
      const userId = await insertUser(c);
      const debtId = await insertDebt(c, userId);
      expect(await tryInsertPayment(c, userId, debtId, '100.00', '-10.00', '110.00')).toBe(
        CHECK_VIOLATION,
      );
      expect(await tryInsertPayment(c, userId, debtId, '100.00', '110.00', '-10.00')).toBe(
        CHECK_VIOLATION,
      );
      expect(await tryInsertPayment(c, userId, debtId, '0.00', '0.00', '0.00')).toBe(
        CHECK_VIOLATION,
      );
    });
  });
});

describe('TASK-018 interest_unpaid keeps 10 decimals (ADR-14)', () => {
  it('TASK-018 interest_unpaid stores and returns 10 decimals exactly', async () => {
    await inTx(async (c) => {
      const userId = await insertUser(c);
      const debtId = await insertDebt(c, userId, { interestUnpaid: '12.3456789012' });
      const { rows } = await c.query<{ v: string }>(
        `SELECT interest_unpaid::text AS v FROM debt WHERE id = $1`,
        [debtId],
      );
      expect(rows[0]!.v).toBe('12.3456789012');
    });
  });

  it('TASK-018 interest_unpaid is declared numeric(24,10)', async () => {
    const { rows } = await sql().query<{ p: number; s: number }>(
      `SELECT numeric_precision::int AS p, numeric_scale::int AS s
         FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'debt' AND column_name = 'interest_unpaid'`,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toEqual({ p: 24, s: 10 });
  });

  it('TASK-018 interest_unpaid defaults to 0 and cannot be negative', async () => {
    await inTx(async (c) => {
      const userId = await insertUser(c);
      expect(await tryInsertDebt(c, userId, { interestUnpaid: '-0.0000000001' })).toBe(
        CHECK_VIOLATION,
      );
      const id = randomUUID();
      await c.query(
        `INSERT INTO debt (id, user_id, direction, person, person_key, principal, currency_code,
                           start_date, capital_outstanding, accrued_through)
         VALUES ($1, $2, 'owed_to_me', 'Ana', 'ana', '200.00', 'BOB', '2026-01-01', '200.00',
                 '2026-01-01')`,
        [id, userId],
      );
      const { rows } = await c.query<{ v: string }>(
        `SELECT interest_unpaid::text AS v FROM debt WHERE id = $1`,
        [id],
      );
      expect(Number(rows[0]!.v)).toBe(0);
    });
  });
});
