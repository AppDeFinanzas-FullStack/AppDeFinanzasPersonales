import { uuidv7 } from 'uuidv7';
import { afterAll, describe, expect, it } from 'vitest';

import { AppError } from '../../src/application/errors.js';
import type { Repositories } from '../../src/application/ports/repositories.js';
import type { UnitOfWork } from '../../src/application/ports/unit-of-work.js';
import { createCategoryRepository } from '../../src/infrastructure/persistence/repositories/category.repository.js';
import { createLedgerRepository } from '../../src/infrastructure/persistence/repositories/ledger.repository.js';
import { createUnitOfWork } from '../../src/infrastructure/persistence/unit-of-work.js';
import { createAccount } from '../factories/account.factory.js';
import { createCategory, uniqueCategoryName } from '../factories/category.factory.js';
import { createLedgerTransaction, deleteLedgerOf } from '../factories/ledger.factory.js';
import { createUser, deleteCreatedUsers } from '../factories/user.factory.js';
import { disconnectTestPrisma, testPrisma } from './setup/db.js';

/**
 * The plan fixes the endpoints (plan §4.5.2) and their errors, and the inputs `CreateCategoryInput`,
 * `UpdateCategoryInput` and `ReorderCategoriesInput` (`@finanzas/contracts`). It does not fix how the
 * service is built nor its signatures. These tests assume, like `SettingsService`:
 * - `createCategoriesService({ uow })` builds it over the `UnitOfWork`.
 * - `create(userId, input)` resolves to `{ created, category }`: `created` is `true` for a new
 *   category (201) and `false` when the id already existed (200); `category.id` is its id.
 * - `update(userId, id, input)` applies a partial `UpdateCategoryInput`; `reorder(userId, input)`
 *   applies a `ReorderCategoriesInput`. Neither return value is checked: the tests read the rows back.
 * - A rejection is an `AppError` with the code and status of the catalogue (ADR-09). A category of
 *   another user does not exist for the user (RNF-14): `NOT_FOUND` or `CATEGORY_NOT_FOUND`, both 404.
 */
interface CreateInput {
  id: string;
  kind: 'expense' | 'income';
  parentId: string | null;
  name: string;
  color?: string;
  icon: string;
}

interface UpdateInput {
  name?: string;
  color?: string;
  icon?: string;
  parentId?: string | null;
}

interface ReorderInput {
  kind: 'expense' | 'income';
  parentId: string | null;
  ids: string[];
}

interface CategoriesServiceUnderTest {
  create(
    userId: string,
    input: CreateInput,
  ): Promise<{ created: boolean; category: { id: string } }>;
  update(userId: string, id: string, input: UpdateInput): Promise<unknown>;
  reorder(userId: string, input: ReorderInput): Promise<unknown>;
}

type CreateCategoriesService = (deps: { uow: UnitOfWork }) => CategoriesServiceUnderTest;

const { createCategoriesService } =
  (await import('../../src/application/services/categories.service.js')) as {
    createCategoriesService: CreateCategoriesService;
  };

const NIL_USER = '00000000-0000-0000-0000-000000000000';
const prisma = testPrisma();

const uow: UnitOfWork = createUnitOfWork(prisma, (tx, userId) => ({
  categories: createCategoryRepository(tx, userId ?? NIL_USER),
  ledger: createLedgerRepository(tx, userId ?? NIL_USER),
}));

const service = createCategoriesService({ uow });
const usedUserIds: string[] = [];

afterAll(async () => {
  await deleteLedgerOf(usedUserIds);
  await deleteCreatedUsers();
  await disconnectTestPrisma();
});

// ---------- Helpers ----------

async function newUserId(): Promise<string> {
  const user = await createUser();
  usedUserIds.push(user.id);
  return user.id;
}

const withUser = <T>(userId: string, fn: (repos: Repositories) => Promise<T>) =>
  uow.run(fn, { userLock: userId });

function createInput(overrides: Partial<CreateInput> = {}): CreateInput {
  return {
    id: uuidv7(),
    kind: 'expense',
    parentId: null,
    name: uniqueCategoryName(),
    icon: 'coffee',
    ...overrides,
  };
}

async function rejectionOf(promise: Promise<unknown>): Promise<AppError> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(AppError);
    return error as AppError;
  }
  throw new Error('Expected the promise to be rejected');
}

interface StoredCategory {
  id: string;
  kind: string;
  parentId: string | null;
  name: string;
  color: string;
  icon: string;
  sortOrder: number;
}

async function stored(userId: string, id: string): Promise<StoredCategory | undefined> {
  const rows = await prisma.$queryRaw<StoredCategory[]>`
    SELECT id::text AS id, kind::text AS kind, parent_id::text AS "parentId", name, color, icon,
           sort_order AS "sortOrder"
      FROM category WHERE user_id = ${userId}::uuid AND id = ${id}::uuid`;
  return rows[0];
}

async function countOf(userId: string): Promise<number> {
  const rows = await prisma.$queryRaw<{ count: number }[]>`
    SELECT count(*)::int AS count FROM category WHERE user_id = ${userId}::uuid`;
  return rows[0]?.count ?? 0;
}

/** The system category of the kind (`debts`) or its subcategory (`debts_interest`). */
async function systemCategory(
  userId: string,
  kind: 'expense' | 'income',
  key: 'debts' | 'debts_interest',
): Promise<StoredCategory> {
  const rows = await prisma.$queryRaw<StoredCategory[]>`
    SELECT id::text AS id, kind::text AS kind, parent_id::text AS "parentId", name, color, icon,
           sort_order AS "sortOrder"
      FROM category
     WHERE user_id = ${userId}::uuid AND kind = ${kind}::category_kind
       AND system_key = ${key}::system_category_key`;
  const row = rows[0];
  if (!row) {
    throw new Error(`The user has no ${key} category`);
  }
  return row;
}

// ---------- create ----------

describe('CategoriesService.create', () => {
  it('RF-M5-02 crea una categoría principal activa del usuario', async () => {
    const userId = await newUserId();
    const name = uniqueCategoryName('Mascota');
    const input = createInput({ name, icon: 'coffee', color: 'teal' });

    const result = await service.create(userId, input);

    expect(result.created).toBe(true);
    expect(result.category.id).toBe(input.id);
    expect(await stored(userId, input.id)).toMatchObject({
      kind: 'expense',
      parentId: null,
      name,
      color: 'teal',
      icon: 'coffee',
    });
  });

  it('TASK-111 dos POST con el mismo id dejan una sola fila', async () => {
    const userId = await newUserId();
    const input = createInput();

    const first = await service.create(userId, input);
    const second = await service.create(userId, input);

    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    expect(second.category.id).toBe(input.id);
    const rows = await prisma.$queryRaw<{ count: number }[]>`
      SELECT count(*)::int AS count FROM category
       WHERE user_id = ${userId}::uuid AND id = ${input.id}::uuid`;
    expect(rows[0]?.count).toBe(1);
  });

  it('RF-M5-04 una hija sin color hereda el del padre', async () => {
    const userId = await newUserId();
    const parent = await createCategory(userId, { color: 'purple' });
    const input = createInput({ parentId: parent.id });

    await service.create(userId, input);

    expect(await stored(userId, input.id)).toMatchObject({ parentId: parent.id, color: 'purple' });
  });

  it('RF-M5-04 una hija con color propio lo conserva', async () => {
    const userId = await newUserId();
    const parent = await createCategory(userId, { color: 'purple' });
    const input = createInput({ parentId: parent.id, color: 'red' });

    await service.create(userId, input);

    expect((await stored(userId, input.id))?.color).toBe('red');
  });

  it('EC-M5-01 "comida" con "Comida" existente en gastos da NAME_TAKEN', async () => {
    const userId = await newUserId();
    const taken = uniqueCategoryName('Almuerzo');
    await createCategory(userId, { name: taken.toUpperCase(), kind: 'expense' });
    const input = createInput({ name: taken.toLowerCase() });

    const error = await rejectionOf(service.create(userId, input));

    expect(error.code).toBe('NAME_TAKEN');
    expect(error.status).toBe(409);
    expect(await stored(userId, input.id)).toBeUndefined();
  });

  it('RF-M5-02 el mismo nombre en otro tipo o bajo otro padre es válido', async () => {
    const userId = await newUserId();
    await createCategory(userId, { name: 'Varios', kind: 'expense' });
    const otherParent = await createCategory(userId, { kind: 'expense' });
    const income = createInput({ name: 'varios', kind: 'income' });
    const child = createInput({ name: 'VARIOS', parentId: otherParent.id });

    await service.create(userId, income);
    await service.create(userId, child);

    expect(await stored(userId, income.id)).toBeDefined();
    expect(await stored(userId, child.id)).toBeDefined();
  });

  it('RF-M5-02 una subcategoría con el nombre de otra del mismo padre da NAME_TAKEN', async () => {
    const userId = await newUserId();
    const parent = await createCategory(userId);
    await createCategory(userId, { parentId: parent.id, name: 'Gatos' });

    const error = await rejectionOf(
      service.create(userId, createInput({ parentId: parent.id, name: 'gatos' })),
    );

    expect(error.code).toBe('NAME_TAKEN');
  });

  it('RF-M5-01 una subcategoría de una subcategoría da HIERARCHY_INVALID', async () => {
    const userId = await newUserId();
    const parent = await createCategory(userId);
    const child = await createCategory(userId, { parentId: parent.id });

    const error = await rejectionOf(service.create(userId, createInput({ parentId: child.id })));

    expect(error.code).toBe('HIERARCHY_INVALID');
    expect(error.status).toBe(422);
  });

  it('RF-M5-01 una subcategoría de otro tipo que su padre da HIERARCHY_INVALID', async () => {
    const userId = await newUserId();
    const parent = await createCategory(userId, { kind: 'expense' });

    const error = await rejectionOf(
      service.create(userId, createInput({ kind: 'income', parentId: parent.id })),
    );

    expect(error.code).toBe('HIERARCHY_INVALID');
  });

  it('TASK-111 una subcategoría de un padre archivado da PARENT_ARCHIVED', async () => {
    const userId = await newUserId();
    const parent = await createCategory(userId, { status: 'archived' });

    const error = await rejectionOf(service.create(userId, createInput({ parentId: parent.id })));

    expect(error.code).toBe('PARENT_ARCHIVED');
    expect(error.status).toBe(409);
  });

  it('RNF-28 la categoría 301 da LIMIT_REACHED y la 300 se crea', async () => {
    const userId = await newUserId();
    const existing = await countOf(userId);
    await prisma.$executeRaw`
      INSERT INTO category (id, user_id, kind, name, color, icon, sort_order)
      SELECT gen_random_uuid(), ${userId}::uuid, 'expense', 'Relleno ' || n, 'blue', 'utensils',
             5000 + n
        FROM generate_series(1, ${299 - existing}::int) AS n`;
    expect(await countOf(userId)).toBe(299);

    const last = createInput();
    await service.create(userId, last);
    expect(await countOf(userId)).toBe(300);

    const over = createInput();
    const error = await rejectionOf(service.create(userId, over));

    expect(error.code).toBe('LIMIT_REACHED');
    expect(error.status).toBe(409);
    expect(await stored(userId, over.id)).toBeUndefined();
    expect(await countOf(userId)).toBe(300);
  });
});

// ---------- update ----------

describe('CategoriesService.update', () => {
  it('RF-M5-02 renombra, cambia el ícono y el color', async () => {
    const userId = await newUserId();
    const category = await createCategory(userId, {
      name: 'Viejo',
      icon: 'utensils',
      color: 'blue',
    });

    await service.update(userId, category.id, { name: 'Nuevo', icon: 'car', color: 'green' });

    expect(await stored(userId, category.id)).toMatchObject({
      name: 'Nuevo',
      icon: 'car',
      color: 'green',
      kind: 'expense',
    });
  });

  it('EC-M5-01 renombrar a un nombre en uso, sin distinguir mayúsculas, da NAME_TAKEN', async () => {
    const userId = await newUserId();
    const taken = uniqueCategoryName('Traslado');
    await createCategory(userId, { name: taken.toUpperCase() });
    const other = await createCategory(userId, { name: 'Otro' });

    const error = await rejectionOf(
      service.update(userId, other.id, { name: taken.toLowerCase() }),
    );

    expect(error.code).toBe('NAME_TAKEN');
    expect((await stored(userId, other.id))?.name).toBe('Otro');
  });

  it('RF-M5-05 renombrar la categoría del sistema da SYSTEM_CATEGORY', async () => {
    const userId = await newUserId();
    const debts = await systemCategory(userId, 'expense', 'debts');

    const error = await rejectionOf(service.update(userId, debts.id, { name: 'Mis deudas' }));

    expect(error.code).toBe('SYSTEM_CATEGORY');
    expect(error.status).toBe(422);
    expect((await stored(userId, debts.id))?.name).toBe(debts.name);
  });

  it('RF-M5-05 renombrar "Intereses" da SYSTEM_CATEGORY', async () => {
    const userId = await newUserId();
    const interest = await systemCategory(userId, 'income', 'debts_interest');

    const error = await rejectionOf(service.update(userId, interest.id, { name: 'Otro' }));

    expect(error.code).toBe('SYSTEM_CATEGORY');
  });

  it('RF-M5-05 mover la categoría del sistema da SYSTEM_CATEGORY', async () => {
    const userId = await newUserId();
    const interest = await systemCategory(userId, 'expense', 'debts_interest');
    const parent = await createCategory(userId, { kind: 'expense' });

    const error = await rejectionOf(service.update(userId, interest.id, { parentId: parent.id }));

    expect(error.code).toBe('SYSTEM_CATEGORY');
  });

  it('RF-M5-05 cambiar el color y el ícono de la categoría del sistema no da error', async () => {
    const userId = await newUserId();
    const debts = await systemCategory(userId, 'expense', 'debts');

    await service.update(userId, debts.id, { color: 'rose', icon: 'car' });

    expect(await stored(userId, debts.id)).toMatchObject({ color: 'rose', icon: 'car' });
  });

  it('RF-M5-01 mover a un padre de otro tipo da HIERARCHY_INVALID', async () => {
    const userId = await newUserId();
    const category = await createCategory(userId, { kind: 'expense' });
    const incomeParent = await createCategory(userId, { kind: 'income' });

    const error = await rejectionOf(
      service.update(userId, category.id, { parentId: incomeParent.id }),
    );

    expect(error.code).toBe('HIERARCHY_INVALID');
    expect(error.status).toBe(422);
    expect((await stored(userId, category.id))?.parentId).toBeNull();
  });

  it('RF-M5-01 una categoría con hijas no pasa a ser hija: HIERARCHY_INVALID', async () => {
    const userId = await newUserId();
    const parent = await createCategory(userId);
    await createCategory(userId, { parentId: parent.id });
    const other = await createCategory(userId);

    const error = await rejectionOf(service.update(userId, parent.id, { parentId: other.id }));

    expect(error.code).toBe('HIERARCHY_INVALID');
  });

  it('RF-M5-01 una categoría no puede ser su propio padre: HIERARCHY_INVALID', async () => {
    const userId = await newUserId();
    const category = await createCategory(userId);

    const error = await rejectionOf(service.update(userId, category.id, { parentId: category.id }));

    expect(error.code).toBe('HIERARCHY_INVALID');
  });

  it('TASK-111 mover a un padre archivado da PARENT_ARCHIVED', async () => {
    const userId = await newUserId();
    const archived = await createCategory(userId, { status: 'archived' });
    const category = await createCategory(userId);

    const error = await rejectionOf(service.update(userId, category.id, { parentId: archived.id }));

    expect(error.code).toBe('PARENT_ARCHIVED');
    expect(error.status).toBe(409);
  });

  it('EC-M5-05 pasar a principal con un nombre en uso da NAME_TAKEN', async () => {
    const userId = await newUserId();
    const shared = uniqueCategoryName('Bienestar');
    await createCategory(userId, { name: shared.toUpperCase() });
    const parent = await createCategory(userId);
    const child = await createCategory(userId, { parentId: parent.id, name: shared.toLowerCase() });

    const error = await rejectionOf(service.update(userId, child.id, { parentId: null }));

    expect(error.code).toBe('NAME_TAKEN');
    expect((await stored(userId, child.id))?.parentId).toBe(parent.id);
  });

  it('EC-M5-05 pasar a principal renombrándola a la vez funciona', async () => {
    const userId = await newUserId();
    const shared = uniqueCategoryName('Bienestar');
    const renamed = uniqueCategoryName('Renombrada');
    await createCategory(userId, { name: shared });
    const parent = await createCategory(userId);
    const child = await createCategory(userId, { parentId: parent.id, name: shared });

    await service.update(userId, child.id, { parentId: null, name: renamed });

    expect(await stored(userId, child.id)).toMatchObject({ parentId: null, name: renamed });
  });

  it('EC-M5-05 pasar a principal con un nombre libre funciona', async () => {
    const userId = await newUserId();
    const parent = await createCategory(userId);
    const child = await createCategory(userId, { parentId: parent.id, name: 'Libre único' });

    await service.update(userId, child.id, { parentId: null });

    expect((await stored(userId, child.id))?.parentId).toBeNull();
  });

  it('EC-M5-03 mover una hija a otro padre del mismo tipo cambia el total del padre anterior', async () => {
    const userId = await newUserId();
    const account = await createAccount(userId, { initialBalanceDate: '2090-01-01' });
    const before = await createCategory(userId);
    const after = await createCategory(userId);
    const child = await createCategory(userId, { parentId: before.id });
    await createLedgerTransaction(userId, {
      kind: 'expense',
      date: '2090-06-10',
      categoryId: child.id,
      entries: [{ accountId: account.id, amount: '-10.00' }],
    });
    const filters = (categoryId: string) => ({
      from: '2090-06-01',
      to: '2090-06-30',
      limit: 50,
      categoryId,
    });
    const totalOf = (categoryId: string) =>
      withUser(userId, async (repos) =>
        (await repos.ledger.summary(filters(categoryId), 'BOB')).expense.toFixed(2),
      );
    expect(await totalOf(before.id)).toBe('10.00');
    expect(await totalOf(after.id)).toBe('0.00');

    await service.update(userId, child.id, { parentId: after.id });

    expect((await stored(userId, child.id))?.parentId).toBe(after.id);
    expect(await totalOf(before.id)).toBe('0.00');
    expect(await totalOf(after.id)).toBe('10.00');
  });

  it('RNF-14 una categoría de otro usuario no existe para el usuario', async () => {
    const userId = await newUserId();
    const otherId = await newUserId();
    const foreign = await createCategory(otherId, { name: 'Ajena' });

    const error = await rejectionOf(service.update(userId, foreign.id, { name: 'Robada' }));

    expect(error.status).toBe(404);
    expect(['NOT_FOUND', 'CATEGORY_NOT_FOUND']).toContain(error.code);
    expect((await stored(otherId, foreign.id))?.name).toBe('Ajena');
  });

  it('RNF-14 no se puede mover una categoría bajo el padre de otro usuario', async () => {
    const userId = await newUserId();
    const otherId = await newUserId();
    const foreignParent = await createCategory(otherId);
    const category = await createCategory(userId);

    await expect(
      service.update(userId, category.id, { parentId: foreignParent.id }),
    ).rejects.toBeInstanceOf(AppError);
    expect((await stored(userId, category.id))?.parentId).toBeNull();
  });
});

// ---------- reorder ----------

describe('CategoriesService.reorder', () => {
  it('RF-M5-02 reasigna el orden de las principales del mismo tipo', async () => {
    const userId = await newUserId();
    const a = await createCategory(userId, { sortOrder: 9001 });
    const b = await createCategory(userId, { sortOrder: 9002 });
    const c = await createCategory(userId, { sortOrder: 9003 });
    const tree = await withUser(userId, (repos) => repos.categories.tree('expense', 'active'));
    const others = tree.map((node) => node.id).filter((id) => ![a.id, b.id, c.id].includes(id));

    await service.reorder(userId, {
      kind: 'expense',
      parentId: null,
      ids: [...others, c.id, a.id, b.id],
    });

    const after = await withUser(userId, (repos) => repos.categories.tree('expense', 'active'));
    const order = after.map((node) => node.id).filter((id) => [a.id, b.id, c.id].includes(id));
    expect(order).toEqual([c.id, a.id, b.id]);
  });

  it('RF-M5-02 reasigna el orden de las subcategorías de un padre', async () => {
    const userId = await newUserId();
    const parent = await createCategory(userId);
    const a = await createCategory(userId, { parentId: parent.id, sortOrder: 1 });
    const b = await createCategory(userId, { parentId: parent.id, sortOrder: 2 });
    const c = await createCategory(userId, { parentId: parent.id, sortOrder: 3 });

    await service.reorder(userId, {
      kind: 'expense',
      parentId: parent.id,
      ids: [b.id, c.id, a.id],
    });

    const tree = await withUser(userId, (repos) => repos.categories.tree('expense', 'active'));
    const node = tree.find((root) => root.id === parent.id);
    expect(node?.children.map((child) => child.id)).toEqual([b.id, c.id, a.id]);
  });

  it('RNF-14 reordenar no cambia las categorías de otro usuario', async () => {
    const userId = await newUserId();
    const otherId = await newUserId();
    const mine = await createCategory(userId);
    const foreign = await createCategory(otherId, { sortOrder: 777 });

    await service
      .reorder(userId, {
        kind: 'expense',
        parentId: null,
        ids: [foreign.id, mine.id],
      })
      .catch(() => undefined);

    expect((await stored(otherId, foreign.id))?.sortOrder).toBe(777);
  });
});
