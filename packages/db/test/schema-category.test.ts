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

/** Inserts a valid auth_user and returns its id. */
async function insertUser(c: pg.PoolClient): Promise<string> {
  const id = randomUUID();
  await c.query(
    `INSERT INTO auth_user (id, name, email, terms_accepted_at, registered_at, timezone)
     VALUES ($1, 'Ana', $2, now(), now(), 'America/La_Paz')`,
    [id, `${id}@test.local`],
  );
  return id;
}

interface CategoryInput {
  id?: string;
  kind?: 'expense' | 'income';
  parentId?: string | null;
  name?: string;
  isSystem?: boolean;
  systemKey?: 'debts' | 'debts_interest' | null;
  status?: 'active' | 'archived';
  archivedAt?: string | null;
  sortOrder?: number;
}

const INSERT_CATEGORY = `INSERT INTO category (id, user_id, kind, parent_id, name, color, icon,
                           is_system, system_key, status, archived_at, sort_order)
                         VALUES ($1, $2, $3, $4, $5, '#22c55e', 'tag', $6, $7, $8, $9, $10)`;

function categoryValues(userId: string, a: CategoryInput): unknown[] {
  const status = a.status ?? 'active';
  const systemKey = a.systemKey ?? null;
  return [
    a.id ?? randomUUID(),
    userId,
    a.kind ?? 'expense',
    a.parentId ?? null,
    a.name ?? 'Comida',
    a.isSystem ?? systemKey !== null,
    systemKey,
    status,
    a.archivedAt !== undefined
      ? a.archivedAt
      : status === 'archived'
        ? new Date().toISOString()
        : null,
    a.sortOrder ?? 0,
  ];
}

function tryInsertCategory(
  c: pg.PoolClient,
  userId: string,
  a: CategoryInput = {},
): Promise<string | null> {
  return sqlState(c, INSERT_CATEGORY, categoryValues(userId, a));
}

async function insertCategory(
  c: pg.PoolClient,
  userId: string,
  a: CategoryInput = {},
): Promise<string> {
  const id = a.id ?? randomUUID();
  await c.query(INSERT_CATEGORY, categoryValues(userId, { ...a, id }));
  return id;
}

/** Inserts the system category "Deudas y préstamos" of `kind` and its "Intereses" subcategory. */
async function insertSystemCategories(
  c: pg.PoolClient,
  userId: string,
  kind: 'expense' | 'income',
): Promise<{ debts: string; interest: string }> {
  const debts = await insertCategory(c, userId, {
    kind,
    name: 'Deudas y préstamos',
    systemKey: 'debts',
  });
  const interest = await insertCategory(c, userId, {
    kind,
    parentId: debts,
    name: 'Intereses',
    systemKey: 'debts_interest',
  });
  return { debts, interest };
}

describe('TASK-015 category table, indexes and trigger exist', () => {
  it('TASK-015 the table category exists', async () => {
    const { rows } = await sql().query<{ reg: string | null }>(
      `SELECT to_regclass('public.category')::text AS reg`,
    );
    expect(rows[0]!.reg).toBe('category');
  });

  it('TASK-015 schema.prisma declares a model mapped to category', () => {
    const path = fileURLToPath(new URL('../prisma/schema.prisma', import.meta.url));
    const source = readFileSync(path, 'utf8');
    const models = [...source.matchAll(/^\s*model\s+\w+\s*\{([^}]*)\}/gm)];
    const mapped = models.filter(([, body]) => /@@map\(\s*"category"\s*\)/.test(body!));
    expect(mapped).toHaveLength(1);
  });

  it('TASK-015 the unique index category_active_name is NULLS NOT DISTINCT on (user_id, kind, parent_id, lower(name)) for active rows', async () => {
    const { rows } = await sql().query<{ indexdef: string }>(
      `SELECT indexdef FROM pg_indexes WHERE schemaname = 'public' AND tablename = 'category'
          AND indexname = 'category_active_name'`,
    );
    expect(rows).toHaveLength(1);
    const def = rows[0]!.indexdef;
    expect(def).toMatch(/UNIQUE INDEX/);
    expect(def).toMatch(/\(user_id, kind, parent_id, lower\(\(name\)::text\)\)/);
    expect(def).toMatch(/NULLS NOT DISTINCT/);
    expect(def).toMatch(/WHERE \(status = 'active'::lifecycle_status\)/);
  });

  it('TASK-015 the unique index category_system_key exists on (user_id, kind, system_key)', async () => {
    const { rows } = await sql().query<{ indexdef: string }>(
      `SELECT indexdef FROM pg_indexes WHERE schemaname = 'public' AND tablename = 'category'
          AND indexname = 'category_system_key'`,
    );
    expect(rows).toHaveLength(1);
    const def = rows[0]!.indexdef;
    expect(def).toMatch(/UNIQUE INDEX/);
    expect(def).toMatch(/\(user_id, kind, system_key\)/);
    expect(def).toMatch(/WHERE \(system_key IS NOT NULL\)/);
  });

  it('TASK-015 the BEFORE INSERT OR UPDATE trigger category_guard exists', async () => {
    const { rows } = await sql().query<{ tgtype: number }>(
      `SELECT tgtype FROM pg_trigger
        WHERE tgrelid = 'public.category'::regclass AND tgname = 'category_guard'
          AND NOT tgisinternal`,
    );
    expect(rows).toHaveLength(1);
    const tgtype = rows[0]!.tgtype;
    // bit 0 (1) = ROW, bit 1 (2) = BEFORE, bit 2 (4) = INSERT, bit 4 (16) = UPDATE
    expect(tgtype & 1).toBe(1);
    expect(tgtype & 2).toBe(2);
    expect(tgtype & 4).toBe(4);
    expect(tgtype & 16).toBe(16);
  });

  it('TASK-015 a minimal category takes the defaults is_system false and status active', async () => {
    await inTx(async (c) => {
      const userId = await insertUser(c);
      const id = randomUUID();
      await c.query(
        `INSERT INTO category (id, user_id, kind, name, color, icon, sort_order)
         VALUES ($1, $2, 'expense', 'Transporte', '#000000', 'bus', 0)`,
        [id, userId],
      );
      const { rows } = await c.query(
        `SELECT is_system, system_key, status::text AS status, archived_at, parent_id
           FROM category WHERE id = $1`,
        [id],
      );
      expect(rows[0]).toEqual({
        is_system: false,
        system_key: null,
        status: 'active',
        archived_at: null,
        parent_id: null,
      });
    });
  });

  it('TASK-015 status archived requires archived_at and vice versa', async () => {
    await inTx(async (c) => {
      const userId = await insertUser(c);
      expect(await tryInsertCategory(c, userId, { status: 'archived', archivedAt: null })).toBe(
        CHECK_VIOLATION,
      );
      expect(
        await tryInsertCategory(c, userId, {
          status: 'active',
          archivedAt: new Date().toISOString(),
        }),
      ).toBe(CHECK_VIOLATION);
      expect(await tryInsertCategory(c, userId, { status: 'archived' })).toBeNull();
    });
  });

  it('TASK-015 is_system must match the presence of system_key', async () => {
    await inTx(async (c) => {
      const userId = await insertUser(c);
      expect(
        await tryInsertCategory(c, userId, { name: 'A', isSystem: true, systemKey: null }),
      ).toBe(CHECK_VIOLATION);
      expect(
        await tryInsertCategory(c, userId, { name: 'B', isSystem: false, systemKey: 'debts' }),
      ).toBe(CHECK_VIOLATION);
    });
  });

  it('TASK-015 the parent must belong to the same user', async () => {
    await inTx(async (c) => {
      const a = await insertUser(c);
      const b = await insertUser(c);
      const parentOfA = await insertCategory(c, a, { name: 'Hogar' });
      expect(await tryInsertCategory(c, b, { parentId: parentOfA, name: 'Luz' })).toBe(
        FK_VIOLATION,
      );
    });
  });

  it('TASK-015 deleting the user removes its categories', async () => {
    await inTx(async (c) => {
      const userId = await insertUser(c);
      const parent = await insertCategory(c, userId, { name: 'Hogar' });
      await insertCategory(c, userId, { parentId: parent, name: 'Luz' });
      await c.query(`DELETE FROM auth_user WHERE id = $1`, [userId]);
      const r = await c.query(`SELECT 1 FROM category WHERE user_id = $1`, [userId]);
      expect(r.rowCount).toBe(0);
    });
  });

  it('TASK-015 a parent with subcategories cannot be deleted', async () => {
    await inTx(async (c) => {
      const userId = await insertUser(c);
      const parent = await insertCategory(c, userId, { name: 'Hogar' });
      await insertCategory(c, userId, { parentId: parent, name: 'Luz' });
      expect(await sqlState(c, `DELETE FROM category WHERE id = $1`, [parent])).toBe(FK_VIOLATION);
    });
  });
});

describe('EC-M5-01 duplicate name ignoring case', () => {
  it('EC-M5-01 "comida" and "Comida" active in expense at top level violate the index', async () => {
    await inTx(async (c) => {
      const userId = await insertUser(c);
      expect(await tryInsertCategory(c, userId, { kind: 'expense', name: 'Comida' })).toBeNull();
      expect(await tryInsertCategory(c, userId, { kind: 'expense', name: 'comida' })).toBe(
        UNIQUE_VIOLATION,
      );
    });
  });

  it('EC-M5-01 "comida" and "Comida" active under the same parent violate the index', async () => {
    await inTx(async (c) => {
      const userId = await insertUser(c);
      const parent = await insertCategory(c, userId, { name: 'Hogar' });
      expect(await tryInsertCategory(c, userId, { parentId: parent, name: 'Comida' })).toBeNull();
      expect(await tryInsertCategory(c, userId, { parentId: parent, name: 'comida' })).toBe(
        UNIQUE_VIOLATION,
      );
    });
  });
});

describe('RF-M5-02 category name', () => {
  it('RF-M5-02 the same name is allowed in a different kind', async () => {
    await inTx(async (c) => {
      const userId = await insertUser(c);
      expect(await tryInsertCategory(c, userId, { kind: 'expense', name: 'Otros' })).toBeNull();
      expect(await tryInsertCategory(c, userId, { kind: 'income', name: 'otros' })).toBeNull();
    });
  });

  it('RF-M5-02 the same name is allowed under a different parent', async () => {
    await inTx(async (c) => {
      const userId = await insertUser(c);
      const hogar = await insertCategory(c, userId, { name: 'Hogar' });
      const auto = await insertCategory(c, userId, { name: 'Auto' });
      expect(await tryInsertCategory(c, userId, { parentId: hogar, name: 'Seguro' })).toBeNull();
      expect(await tryInsertCategory(c, userId, { parentId: auto, name: 'seguro' })).toBeNull();
    });
  });

  it('RF-M5-02 a top-level name and a subcategory with the same name can coexist', async () => {
    await inTx(async (c) => {
      const userId = await insertUser(c);
      const hogar = await insertCategory(c, userId, { name: 'Hogar' });
      expect(await tryInsertCategory(c, userId, { name: 'Servicios' })).toBeNull();
      expect(await tryInsertCategory(c, userId, { parentId: hogar, name: 'servicios' })).toBeNull();
    });
  });

  it('RF-M5-02 an archived category does not block an active one with the same name', async () => {
    await inTx(async (c) => {
      const userId = await insertUser(c);
      expect(await tryInsertCategory(c, userId, { name: 'Ropa', status: 'archived' })).toBeNull();
      expect(await tryInsertCategory(c, userId, { name: 'ropa' })).toBeNull();
    });
  });

  it('RF-M5-02 two users can each have an active category with the same name', async () => {
    await inTx(async (c) => {
      const a = await insertUser(c);
      const b = await insertUser(c);
      expect(await tryInsertCategory(c, a, { name: 'Salud' })).toBeNull();
      expect(await tryInsertCategory(c, b, { name: 'Salud' })).toBeNull();
    });
  });

  it('RF-M5-02 renaming a category to a name taken ignoring case violates the index', async () => {
    await inTx(async (c) => {
      const userId = await insertUser(c);
      await insertCategory(c, userId, { name: 'Salud' });
      const other = await insertCategory(c, userId, { name: 'Ocio' });
      expect(await sqlState(c, `UPDATE category SET name = 'SALUD' WHERE id = $1`, [other])).toBe(
        UNIQUE_VIOLATION,
      );
    });
  });

  it.each([
    ['', CHECK_VIOLATION],
    [' Comida', CHECK_VIOLATION],
    ['Comida ', CHECK_VIOLATION],
    ['x'.repeat(31), STRING_TOO_LONG],
  ])('RF-M5-02 the name %j is rejected', async (name, state) => {
    await inTx(async (c) => {
      const userId = await insertUser(c);
      expect(await tryInsertCategory(c, userId, { name })).toBe(state);
    });
  });

  it.each(['A', 'x'.repeat(30)])('RF-M5-02 the name %j is accepted', async (name) => {
    await inTx(async (c) => {
      const userId = await insertUser(c);
      expect(await tryInsertCategory(c, userId, { name })).toBeNull();
    });
  });
});

describe('RF-M5-01 the kind of a category never changes', () => {
  it('RF-M5-01 changing the kind of a top-level category fails', async () => {
    await inTx(async (c) => {
      const userId = await insertUser(c);
      const id = await insertCategory(c, userId, { kind: 'expense', name: 'Comida' });
      expect(
        await sqlState(c, `UPDATE category SET kind = 'income' WHERE id = $1`, [id]),
      ).not.toBeNull();
      const { rows } = await c.query<{ kind: string }>(
        `SELECT kind::text AS kind FROM category WHERE id = $1`,
        [id],
      );
      expect(rows[0]!.kind).toBe('expense');
    });
  });

  it('RF-M5-01 changing the kind of an income category to expense fails', async () => {
    await inTx(async (c) => {
      const userId = await insertUser(c);
      const id = await insertCategory(c, userId, { kind: 'income', name: 'Sueldo' });
      expect(
        await sqlState(c, `UPDATE category SET kind = 'expense' WHERE id = $1`, [id]),
      ).not.toBeNull();
    });
  });

  it('RF-M5-01 changing the kind together with editable fields also fails', async () => {
    await inTx(async (c) => {
      const userId = await insertUser(c);
      const id = await insertCategory(c, userId, { kind: 'expense', name: 'Comida' });
      expect(
        await sqlState(c, `UPDATE category SET name = 'Sueldo', kind = 'income' WHERE id = $1`, [
          id,
        ]),
      ).not.toBeNull();
      const { rows } = await c.query<{ name: string }>(`SELECT name FROM category WHERE id = $1`, [
        id,
      ]);
      expect(rows[0]!.name).toBe('Comida');
    });
  });

  it('RF-M5-01 a subcategory must have the same kind as its parent', async () => {
    await inTx(async (c) => {
      const userId = await insertUser(c);
      const parent = await insertCategory(c, userId, { kind: 'expense', name: 'Hogar' });
      expect(
        await tryInsertCategory(c, userId, { kind: 'income', parentId: parent, name: 'Alquiler' }),
      ).not.toBeNull();
      expect(
        await tryInsertCategory(c, userId, { kind: 'expense', parentId: parent, name: 'Alquiler' }),
      ).toBeNull();
    });
  });

  it('RF-M5-01 moving a category under a parent of the other kind fails', async () => {
    await inTx(async (c) => {
      const userId = await insertUser(c);
      const incomeParent = await insertCategory(c, userId, { kind: 'income', name: 'Trabajo' });
      const expense = await insertCategory(c, userId, { kind: 'expense', name: 'Taxi' });
      expect(
        await sqlState(c, `UPDATE category SET parent_id = $1 WHERE id = $2`, [
          incomeParent,
          expense,
        ]),
      ).not.toBeNull();
    });
  });

  it('RF-M5-01 name, color, icon and status of a regular category can be edited', async () => {
    await inTx(async (c) => {
      const userId = await insertUser(c);
      const id = await insertCategory(c, userId, { name: 'Comida' });
      expect(
        await sqlState(
          c,
          `UPDATE category SET name = 'Alimentos', color = '#ef4444', icon = 'food' WHERE id = $1`,
          [id],
        ),
      ).toBeNull();
      expect(
        await sqlState(
          c,
          `UPDATE category SET status = 'archived', archived_at = now() WHERE id = $1`,
          [id],
        ),
      ).toBeNull();
    });
  });
});

describe('TASK-015 category_guard: a single level of hierarchy', () => {
  it('TASK-015 a subcategory of a subcategory is rejected', async () => {
    await inTx(async (c) => {
      const userId = await insertUser(c);
      const parent = await insertCategory(c, userId, { name: 'Hogar' });
      const child = await insertCategory(c, userId, { parentId: parent, name: 'Servicios' });
      expect(await tryInsertCategory(c, userId, { parentId: child, name: 'Luz' })).not.toBeNull();
    });
  });

  it('TASK-015 moving a category under a subcategory is rejected', async () => {
    await inTx(async (c) => {
      const userId = await insertUser(c);
      const parent = await insertCategory(c, userId, { name: 'Hogar' });
      const child = await insertCategory(c, userId, { parentId: parent, name: 'Servicios' });
      const loose = await insertCategory(c, userId, { name: 'Luz' });
      expect(
        await sqlState(c, `UPDATE category SET parent_id = $1 WHERE id = $2`, [child, loose]),
      ).not.toBeNull();
    });
  });

  it('TASK-015 a subcategory under an archived parent is rejected', async () => {
    await inTx(async (c) => {
      const userId = await insertUser(c);
      const parent = await insertCategory(c, userId, { name: 'Hogar', status: 'archived' });
      expect(await tryInsertCategory(c, userId, { parentId: parent, name: 'Luz' })).not.toBeNull();
    });
  });

  it('TASK-015 moving a category under an archived parent is rejected', async () => {
    await inTx(async (c) => {
      const userId = await insertUser(c);
      const parent = await insertCategory(c, userId, { name: 'Hogar', status: 'archived' });
      const loose = await insertCategory(c, userId, { name: 'Luz' });
      expect(
        await sqlState(c, `UPDATE category SET parent_id = $1 WHERE id = $2`, [parent, loose]),
      ).not.toBeNull();
    });
  });

  it('TASK-015 a category with subcategories cannot become a subcategory', async () => {
    await inTx(async (c) => {
      const userId = await insertUser(c);
      const hogar = await insertCategory(c, userId, { name: 'Hogar' });
      await insertCategory(c, userId, { parentId: hogar, name: 'Luz' });
      const vivienda = await insertCategory(c, userId, { name: 'Vivienda' });
      expect(
        await sqlState(c, `UPDATE category SET parent_id = $1 WHERE id = $2`, [vivienda, hogar]),
      ).not.toBeNull();
      const { rows } = await c.query<{ parent_id: string | null }>(
        `SELECT parent_id FROM category WHERE id = $1`,
        [hogar],
      );
      expect(rows[0]!.parent_id).toBeNull();
    });
  });

  it('TASK-015 a top-level category without subcategories can move under an active parent of the same kind', async () => {
    await inTx(async (c) => {
      const userId = await insertUser(c);
      const hogar = await insertCategory(c, userId, { name: 'Hogar' });
      const luz = await insertCategory(c, userId, { name: 'Luz' });
      expect(
        await sqlState(c, `UPDATE category SET parent_id = $1 WHERE id = $2`, [hogar, luz]),
      ).toBeNull();
    });
  });

  it('TASK-015 a subcategory can move back to the top level', async () => {
    await inTx(async (c) => {
      const userId = await insertUser(c);
      const hogar = await insertCategory(c, userId, { name: 'Hogar' });
      const luz = await insertCategory(c, userId, { parentId: hogar, name: 'Luz' });
      expect(
        await sqlState(c, `UPDATE category SET parent_id = NULL WHERE id = $1`, [luz]),
      ).toBeNull();
    });
  });
});

describe('RF-M5-05 system categories only change color and icon', () => {
  it.each(['expense', 'income'] as const)(
    'RF-M5-05 the system categories of %s can be inserted with their subcategory',
    async (kind) => {
      await inTx(async (c) => {
        const userId = await insertUser(c);
        const { debts, interest } = await insertSystemCategories(c, userId, kind);
        const { rows } = await c.query<{ id: string; is_system: boolean; system_key: string }>(
          `SELECT id, is_system, system_key::text AS system_key FROM category
            WHERE id = ANY($1::uuid[]) ORDER BY system_key`,
          [[debts, interest]],
        );
        expect(rows).toEqual([
          { id: debts, is_system: true, system_key: 'debts' },
          { id: interest, is_system: true, system_key: 'debts_interest' },
        ]);
      });
    },
  );

  it('RF-M5-05 a second system category with the same key and kind violates category_system_key', async () => {
    await inTx(async (c) => {
      const userId = await insertUser(c);
      await insertSystemCategories(c, userId, 'expense');
      expect(
        await tryInsertCategory(c, userId, {
          kind: 'expense',
          name: 'Deudas 2',
          systemKey: 'debts',
        }),
      ).toBe(UNIQUE_VIOLATION);
    });
  });

  it('RF-M5-05 the same system key is allowed once per kind and per user', async () => {
    await inTx(async (c) => {
      const a = await insertUser(c);
      const b = await insertUser(c);
      await insertSystemCategories(c, a, 'expense');
      await insertSystemCategories(c, a, 'income');
      await insertSystemCategories(c, b, 'expense');
      const { rows } = await c.query<{ n: string }>(
        `SELECT count(*)::text AS n FROM category WHERE user_id = ANY($1::uuid[]) AND is_system`,
        [[a, b]],
      );
      expect(rows[0]!.n).toBe('6');
    });
  });

  it.each(['debts', 'interest'] as const)(
    'RF-M5-05 the color and the icon of the system category %s can be changed',
    async (which) => {
      await inTx(async (c) => {
        const userId = await insertUser(c);
        const ids = await insertSystemCategories(c, userId, 'expense');
        expect(
          await sqlState(
            c,
            `UPDATE category SET color = '#ef4444', icon = 'hand-coins' WHERE id = $1`,
            [ids[which]],
          ),
        ).toBeNull();
        const { rows } = await c.query(`SELECT color, icon FROM category WHERE id = $1`, [
          ids[which],
        ]);
        expect(rows[0]).toEqual({ color: '#ef4444', icon: 'hand-coins' });
      });
    },
  );

  it.each(['debts', 'interest'] as const)(
    'RF-M5-05 renaming the system category %s fails',
    async (which) => {
      await inTx(async (c) => {
        const userId = await insertUser(c);
        const ids = await insertSystemCategories(c, userId, 'expense');
        expect(
          await sqlState(c, `UPDATE category SET name = 'Préstamos' WHERE id = $1`, [ids[which]]),
        ).not.toBeNull();
      });
    },
  );

  it.each(['debts', 'interest'] as const)(
    'RF-M5-05 archiving the system category %s fails',
    async (which) => {
      await inTx(async (c) => {
        const userId = await insertUser(c);
        const ids = await insertSystemCategories(c, userId, 'expense');
        expect(
          await sqlState(
            c,
            `UPDATE category SET status = 'archived', archived_at = now() WHERE id = $1`,
            [ids[which]],
          ),
        ).not.toBeNull();
      });
    },
  );

  it('RF-M5-05 moving the system subcategory "Intereses" to the top level fails', async () => {
    await inTx(async (c) => {
      const userId = await insertUser(c);
      const { interest } = await insertSystemCategories(c, userId, 'expense');
      expect(
        await sqlState(c, `UPDATE category SET parent_id = NULL WHERE id = $1`, [interest]),
      ).not.toBeNull();
    });
  });

  it('RF-M5-05 moving the system category "Deudas y préstamos" under another category fails', async () => {
    await inTx(async (c) => {
      const userId = await insertUser(c);
      const otherParent = await insertCategory(c, userId, { name: 'Finanzas' });
      const debts = await insertCategory(c, userId, {
        name: 'Deudas y préstamos',
        systemKey: 'debts',
      });
      expect(
        await sqlState(c, `UPDATE category SET parent_id = $1 WHERE id = $2`, [otherParent, debts]),
      ).not.toBeNull();
    });
  });

  it('RF-M5-05 removing the system flag fails', async () => {
    await inTx(async (c) => {
      const userId = await insertUser(c);
      const { debts } = await insertSystemCategories(c, userId, 'expense');
      expect(
        await sqlState(
          c,
          `UPDATE category SET is_system = false, system_key = NULL WHERE id = $1`,
          [debts],
        ),
      ).not.toBeNull();
    });
  });

  it('RF-M5-05 changing color together with the name of a system category fails and keeps the row', async () => {
    await inTx(async (c) => {
      const userId = await insertUser(c);
      const { debts } = await insertSystemCategories(c, userId, 'expense');
      expect(
        await sqlState(
          c,
          `UPDATE category SET color = '#000000', name = 'Otra cosa' WHERE id = $1`,
          [debts],
        ),
      ).not.toBeNull();
      const { rows } = await c.query(`SELECT name, color FROM category WHERE id = $1`, [debts]);
      expect(rows[0]).toEqual({ name: 'Deudas y préstamos', color: '#22c55e' });
    });
  });
});
