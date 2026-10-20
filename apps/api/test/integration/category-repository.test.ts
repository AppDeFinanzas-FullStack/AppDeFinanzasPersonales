import { uuidv7 } from 'uuidv7';
import { afterAll, describe, expect, it } from 'vitest';

import type { Repositories } from '../../src/application/ports/repositories.js';
import type { UnitOfWork } from '../../src/application/ports/unit-of-work.js';
import { createCategoryRepository } from '../../src/infrastructure/persistence/repositories/category.repository.js';
import { createUnitOfWork } from '../../src/infrastructure/persistence/unit-of-work.js';
import { createAccount } from '../factories/account.factory.js';
import {
  createCategory,
  createCategoryBudget,
  createCategoryRule,
  createCategoryShortcut,
  deleteCategoryUsageOf,
  uniqueCategoryName,
} from '../factories/category.factory.js';
import { createLedgerTransaction, deleteLedgerOf } from '../factories/ledger.factory.js';
import { createUser, deleteCreatedUsers, type TestUser } from '../factories/user.factory.js';
import { disconnectTestPrisma, testPrisma } from './setup/db.js';

/**
 * The task fixes the operations of the repository (tasks.md, TASK-110) but not the name of its
 * factory nor its row shapes. These tests assume, like those of TASK-099:
 * - `createCategoryRepository(tx, userId)` builds the repository over the client of a transaction;
 *   `Repositories` exposes it as `categories`. The user comes from the `UnitOfWork` (`userLock`),
 *   never from an argument (ADR-05).
 * - A category row has `id`, `kind`, `parentId`, `name`, `color`, `icon`, `isSystem`, `status`,
 *   `archivedAt` and `sortOrder`. `insert` takes `id`, `kind`, `parentId`, `name`, `color`, `icon`
 *   and `sortOrder` (it is always created active and not of the system); `update(id, patch)` takes
 *   some of `name`, `color`, `icon` and `parentId`.
 * - `tree(kind, status)` returns the roots of that kind and status by `sortOrder`, each one a
 *   `CategoryNode` of plan §4.5.1 (`id`, `kind`, `name`, `color`, `icon`, `isSystem`, `status`)
 *   whose `children` are its subcategories of that status, by `sortOrder`, with no `children`.
 * - `get` returns `null` when the user has no such category; `count()` counts the categories of the
 *   user; `hasMovements(id)` is a boolean.
 * - `setOrder(ids)` gives each category a `sortOrder` that follows the position of its id.
 * - `usage(id)` returns `{ budgets: { id }[], recurring: { id, name }[], shortcuts: { id, name }[] }`,
 *   like those lists of `ArchiveImpactDto` (plan §4.5.1).
 * - `idsWithChildren(id)` returns the id of the category and those of its subcategories, in any
 *   order, and `[]` when the user has no such category.
 */
const NIL_USER = '00000000-0000-0000-0000-000000000000';

const uow: UnitOfWork = createUnitOfWork(testPrisma(), (tx, userId) => ({
  categories: createCategoryRepository(tx, userId ?? NIL_USER),
}));

const usedUserIds: string[] = [];

afterAll(async () => {
  await deleteCategoryUsageOf(usedUserIds);
  await deleteLedgerOf(usedUserIds);
  await deleteCreatedUsers();
  await disconnectTestPrisma();
});

// ---------- Helpers ----------

async function newUser(): Promise<TestUser> {
  const user = await createUser();
  usedUserIds.push(user.id);
  return user;
}

const withUser = <T>(userId: string, fn: (repos: Repositories) => Promise<T>) =>
  uow.run(fn, { userLock: userId });

interface TreeNode {
  id: string;
  children: TreeNode[];
}

/** The roots of the tree among the ids, in the order of the tree. */
function rootsAmong<T extends TreeNode>(tree: readonly T[], ids: string[]): T[] {
  return tree.filter((node) => ids.includes(node.id));
}

/** Every id of the tree, roots and subcategories. */
function allIds(tree: readonly TreeNode[]): string[] {
  return tree.flatMap((node) => [node.id, ...node.children.map((child) => child.id)]);
}

const sorted = (ids: readonly string[]): string[] => [...ids].sort();

/** The id of the user's system category of that kind and key, read outside of any UnitOfWork. */
async function systemCategoryId(userId: string, kind: 'expense' | 'income'): Promise<string> {
  const rows = await testPrisma().$queryRaw<{ id: string }[]>`
    SELECT id::text AS id FROM category
     WHERE user_id = ${userId}::uuid AND kind = ${kind}::category_kind AND system_key = 'debts'`;
  const id = rows[0]?.id;
  if (!id) {
    throw new Error('The user has no system category');
  }
  return id;
}

interface StoredCategory {
  name: string;
  color: string;
  icon: string;
  parentId: string | null;
  sortOrder: number;
}

/** The stored row of a category, read outside of any UnitOfWork. */
async function storedCategory(id: string): Promise<StoredCategory | undefined> {
  const rows = await testPrisma().$queryRaw<StoredCategory[]>`
    SELECT name, color, icon, parent_id::text AS "parentId", sort_order AS "sortOrder"
      FROM category WHERE id = ${id}::uuid`;
  return rows[0];
}

// ---------- insert y get ----------

describe('categories.insert y categories.get', () => {
  it('TASK-110 insert guarda una categoría principal activa y get la devuelve con sus campos', async () => {
    const user = await newUser();
    const id = uuidv7();
    const name = uniqueCategoryName('Comida');

    await withUser(user.id, (repos) =>
      repos.categories.insert({
        id,
        kind: 'expense',
        parentId: null,
        name,
        color: 'orange',
        icon: 'utensils',
        sortOrder: 7,
      }),
    );
    const category = await withUser(user.id, (repos) => repos.categories.get(id));

    expect(category).toMatchObject({
      id,
      kind: 'expense',
      parentId: null,
      name,
      color: 'orange',
      icon: 'utensils',
      isSystem: false,
      status: 'active',
      archivedAt: null,
      sortOrder: 7,
    });
  });

  it('TASK-110 insert guarda una subcategoría bajo su padre', async () => {
    const user = await newUser();
    const parent = await createCategory(user.id, { kind: 'income' });
    const id = uuidv7();

    await withUser(user.id, (repos) =>
      repos.categories.insert({
        id,
        kind: 'income',
        parentId: parent.id,
        name: uniqueCategoryName('Sueldo'),
        color: 'green',
        icon: 'coffee',
        sortOrder: 1,
      }),
    );
    const child = await withUser(user.id, (repos) => repos.categories.get(id));

    expect(child).toMatchObject({ id, kind: 'income', parentId: parent.id, status: 'active' });
  });

  it('TASK-110 get de una categoría del sistema la marca como del sistema', async () => {
    const user = await newUser();
    const id = await systemCategoryId(user.id, 'expense');

    const category = await withUser(user.id, (repos) => repos.categories.get(id));

    expect(category).toMatchObject({ id, kind: 'expense', isSystem: true, parentId: null });
  });

  it('TASK-110 get de una categoría archivada devuelve su estado y su fecha de archivo', async () => {
    const user = await newUser();
    const archived = await createCategory(user.id, { status: 'archived' });

    const category = await withUser(user.id, (repos) => repos.categories.get(archived.id));

    expect(category?.status).toBe('archived');
    expect(category?.archivedAt).toBeInstanceOf(Date);
  });

  it('TASK-110 get de una categoría inexistente devuelve null', async () => {
    const user = await newUser();

    expect(await withUser(user.id, (repos) => repos.categories.get(uuidv7()))).toBeNull();
  });
});

// ---------- tree ----------

describe('categories.tree', () => {
  it('TASK-110 tree(kind, status) devuelve dos niveles: los padres y sus hijas, cada nivel por sort_order', async () => {
    const user = await newUser();
    const second = await createCategory(user.id, { sortOrder: 2002 });
    const first = await createCategory(user.id, { sortOrder: 2001 });
    const childB = await createCategory(user.id, { parentId: first.id, sortOrder: 2 });
    const childA = await createCategory(user.id, { parentId: first.id, sortOrder: 1 });
    const childC = await createCategory(user.id, { parentId: first.id, sortOrder: 3 });

    const tree = await withUser(user.id, (repos) => repos.categories.tree('expense', 'active'));

    const mine = rootsAmong(tree, [first.id, second.id]);
    expect(mine.map((node) => node.id)).toEqual([first.id, second.id]);
    expect(mine[0]).toMatchObject({
      id: first.id,
      kind: 'expense',
      name: first.name,
      color: 'blue',
      icon: 'utensils',
      isSystem: false,
      status: 'active',
    });
    expect(mine[0]?.children.map((child) => child.id)).toEqual([childA.id, childB.id, childC.id]);
    expect(mine[0]?.children.flatMap((child) => child.children)).toEqual([]);
    expect(mine[1]?.children).toEqual([]);
    expect(tree.map((node) => node.id)).not.toContain(childA.id);
  });

  it('TASK-110 tree devuelve solo las categorías del tipo pedido', async () => {
    const user = await newUser();
    const expense = await createCategory(user.id, { kind: 'expense' });
    const income = await createCategory(user.id, { kind: 'income' });

    const [expenseTree, incomeTree] = await withUser(
      user.id,
      async (repos) =>
        [
          await repos.categories.tree('expense', 'active'),
          await repos.categories.tree('income', 'active'),
        ] as const,
    );

    expect(allIds(expenseTree)).toContain(expense.id);
    expect(allIds(expenseTree)).not.toContain(income.id);
    expect(allIds(incomeTree)).toContain(income.id);
    expect(allIds(incomeTree)).not.toContain(expense.id);
    expect(expenseTree.every((node) => node.kind === 'expense')).toBe(true);
    expect(incomeTree.every((node) => node.kind === 'income')).toBe(true);
  });

  it('TASK-110 tree de activas no incluye las archivadas; tree de archivadas trae el padre archivado con sus hijas', async () => {
    const user = await newUser();
    const active = await createCategory(user.id);
    const archivedChildOfActive = await createCategory(user.id, { parentId: active.id });
    await testPrisma().$executeRaw`
      UPDATE category SET status = 'archived', archived_at = now()
       WHERE id = ${archivedChildOfActive.id}::uuid`;
    const archivedParent = await createCategory(user.id);
    const archivedChild = await createCategory(user.id, { parentId: archivedParent.id });
    await testPrisma().$executeRaw`
      UPDATE category SET status = 'archived', archived_at = now()
       WHERE id IN (${archivedChild.id}::uuid, ${archivedParent.id}::uuid)`;

    const [activeTree, archivedTree] = await withUser(
      user.id,
      async (repos) =>
        [
          await repos.categories.tree('expense', 'active'),
          await repos.categories.tree('expense', 'archived'),
        ] as const,
    );

    expect(allIds(activeTree)).toContain(active.id);
    expect(allIds(activeTree)).not.toContain(archivedChildOfActive.id);
    expect(allIds(activeTree)).not.toContain(archivedParent.id);
    expect(allIds(activeTree)).not.toContain(archivedChild.id);
    const [archivedNode] = rootsAmong(archivedTree, [archivedParent.id]);
    expect(archivedNode).toMatchObject({ id: archivedParent.id, status: 'archived' });
    expect(archivedNode?.children.map((child) => child.id)).toEqual([archivedChild.id]);
    expect(archivedTree.map((node) => node.id)).not.toContain(active.id);
  });
});

// ---------- update ----------

describe('categories.update', () => {
  it('TASK-110 update cambia el nombre, el color y el ícono de la categoría', async () => {
    const user = await newUser();
    const category = await createCategory(user.id);
    const name = uniqueCategoryName('Transporte');

    await withUser(user.id, (repos) =>
      repos.categories.update(category.id, { name, color: 'purple', icon: 'car' }),
    );
    const updated = await withUser(user.id, (repos) => repos.categories.get(category.id));

    expect(updated).toMatchObject({
      id: category.id,
      name,
      color: 'purple',
      icon: 'car',
      parentId: null,
      kind: 'expense',
    });
  });

  it('TASK-110 update mueve una hija a otro padre y la pasa a principal con parentId null', async () => {
    const user = await newUser();
    const from = await createCategory(user.id);
    const to = await createCategory(user.id);
    const child = await createCategory(user.id, { parentId: from.id });

    await withUser(user.id, (repos) => repos.categories.update(child.id, { parentId: to.id }));
    const moved = await withUser(user.id, (repos) => repos.categories.get(child.id));
    expect(moved?.parentId).toBe(to.id);

    await withUser(user.id, (repos) => repos.categories.update(child.id, { parentId: null }));
    const promoted = await withUser(user.id, (repos) => repos.categories.get(child.id));
    expect(promoted?.parentId).toBeNull();
  });
});

// ---------- setOrder ----------

describe('categories.setOrder', () => {
  it('TASK-110 setOrder(ids) reasigna sort_order en el orden dado y tree lo respeta', async () => {
    const user = await newUser();
    const a = await createCategory(user.id, { sortOrder: 3001 });
    const b = await createCategory(user.id, { sortOrder: 3002 });
    const c = await createCategory(user.id, { sortOrder: 3003 });

    await withUser(user.id, (repos) => repos.categories.setOrder([c.id, a.id, b.id]));
    const tree = await withUser(user.id, (repos) => repos.categories.tree('expense', 'active'));

    expect(rootsAmong(tree, [a.id, b.id, c.id]).map((node) => node.id)).toEqual([
      c.id,
      a.id,
      b.id,
    ]);
    const orders = await Promise.all([c.id, a.id, b.id].map((id) => storedCategory(id)));
    const values = orders.map((row) => row?.sortOrder ?? Number.NaN);
    expect([...values].sort((x, y) => x - y)).toEqual(values);
    expect(new Set(values).size).toBe(3);
  });

  it('TASK-110 setOrder ordena las hijas de un padre', async () => {
    const user = await newUser();
    const parent = await createCategory(user.id);
    const x = await createCategory(user.id, { parentId: parent.id, sortOrder: 1 });
    const y = await createCategory(user.id, { parentId: parent.id, sortOrder: 2 });

    await withUser(user.id, (repos) => repos.categories.setOrder([y.id, x.id]));
    const tree = await withUser(user.id, (repos) => repos.categories.tree('expense', 'active'));

    const [node] = rootsAmong(tree, [parent.id]);
    expect(node?.children.map((child) => child.id)).toEqual([y.id, x.id]);
  });
});

// ---------- count ----------

describe('categories.count', () => {
  it('TASK-110 count devuelve cuántas categorías tiene el usuario', async () => {
    const user = await newUser();
    const before = await withUser(user.id, (repos) => repos.categories.count());
    const parent = await createCategory(user.id);
    await createCategory(user.id, { parentId: parent.id });
    await createCategory(user.id, { kind: 'income' });

    const after = await withUser(user.id, (repos) => repos.categories.count());

    expect(after).toBe(before + 3);
  });
});

// ---------- hasMovements ----------

describe('categories.hasMovements', () => {
  it('TASK-110 hasMovements es false para una categoría sin movimientos y true cuando tiene uno', async () => {
    const user = await newUser();
    const account = await createAccount(user.id);
    const empty = await createCategory(user.id);
    const used = await createCategory(user.id);
    await createLedgerTransaction(user.id, {
      kind: 'expense',
      categoryId: used.id,
      date: '2090-01-10',
      entries: [{ accountId: account.id, amount: '-10.00' }],
    });

    const [emptyHas, usedHas] = await withUser(
      user.id,
      async (repos) =>
        [
          await repos.categories.hasMovements(empty.id),
          await repos.categories.hasMovements(used.id),
        ] as const,
    );

    expect(emptyHas).toBe(false);
    expect(usedHas).toBe(true);
  });

  it('TASK-110 hasMovements cuenta una transacción eliminada que todavía puede deshacerse', async () => {
    const user = await newUser();
    const account = await createAccount(user.id);
    const category = await createCategory(user.id, { kind: 'income' });
    await createLedgerTransaction(user.id, {
      kind: 'income',
      categoryId: category.id,
      date: '2090-01-10',
      deletedAt: new Date(),
      entries: [{ accountId: account.id, amount: '25.00' }],
    });

    expect(await withUser(user.id, (repos) => repos.categories.hasMovements(category.id))).toBe(
      true,
    );
  });
});

// ---------- usage ----------

describe('categories.usage', () => {
  it('TASK-110 usage lista los presupuestos, las reglas y los atajos que usan la categoría', async () => {
    const user = await newUser();
    const account = await createAccount(user.id);
    const category = await createCategory(user.id);
    const other = await createCategory(user.id);
    const budgetId = await createCategoryBudget(user.id, category.id);
    const rule = await createCategoryRule(user.id, category.id, account.id);
    const shortcut = await createCategoryShortcut(user.id, category.id, account.id);
    await createCategoryShortcut(user.id, other.id, account.id);

    const usage = await withUser(user.id, (repos) => repos.categories.usage(category.id));

    expect(usage.budgets.map((budget) => budget.id)).toEqual([budgetId]);
    expect(usage.recurring).toEqual([{ id: rule.id, name: rule.name }]);
    expect(usage.shortcuts).toEqual([{ id: shortcut.id, name: shortcut.name }]);
  });

  it('TASK-110 usage de una categoría sin presupuestos, reglas ni atajos devuelve listas vacías', async () => {
    const user = await newUser();
    const category = await createCategory(user.id);

    const usage = await withUser(user.id, (repos) => repos.categories.usage(category.id));

    expect(usage.budgets).toEqual([]);
    expect(usage.recurring).toEqual([]);
    expect(usage.shortcuts).toEqual([]);
  });
});

// ---------- idsWithChildren ----------

describe('categories.idsWithChildren', () => {
  it('RF-M5-03 idsWithChildren devuelve el padre y sus hijas', async () => {
    const user = await newUser();
    const parent = await createCategory(user.id);
    const first = await createCategory(user.id, { parentId: parent.id });
    const second = await createCategory(user.id, { parentId: parent.id });
    const otherParent = await createCategory(user.id);
    const otherChild = await createCategory(user.id, { parentId: otherParent.id });

    const ids = await withUser(user.id, (repos) => repos.categories.idsWithChildren(parent.id));

    expect(sorted(ids)).toEqual(sorted([parent.id, first.id, second.id]));
    expect(ids).not.toContain(otherParent.id);
    expect(ids).not.toContain(otherChild.id);
  });

  it('RF-M5-03 idsWithChildren de una subcategoría o de una categoría sin hijas devuelve solo su id', async () => {
    const user = await newUser();
    const parent = await createCategory(user.id);
    const child = await createCategory(user.id, { parentId: parent.id });
    const lonely = await createCategory(user.id);

    const [childIds, lonelyIds] = await withUser(
      user.id,
      async (repos) =>
        [
          await repos.categories.idsWithChildren(child.id),
          await repos.categories.idsWithChildren(lonely.id),
        ] as const,
    );

    expect(childIds).toEqual([child.id]);
    expect(lonelyIds).toEqual([lonely.id]);
  });

  it('TASK-110 idsWithChildren de una categoría inexistente devuelve una lista vacía', async () => {
    const user = await newUser();

    expect(await withUser(user.id, (repos) => repos.categories.idsWithChildren(uuidv7()))).toEqual(
      [],
    );
  });
});

// ---------- aislamiento ----------

describe('categories aislamiento', () => {
  it('RN-09 un usuario no ve las categorías de otro: get da null y tree y count no las incluyen', async () => {
    const [ana, beto] = await Promise.all([newUser(), newUser()]);
    const anaCountBefore = await withUser(ana.id, (repos) => repos.categories.count());
    const betoParent = await createCategory(beto.id);
    const betoChild = await createCategory(beto.id, { parentId: betoParent.id });
    const betoArchived = await createCategory(beto.id, { status: 'archived' });
    const betoSystem = await systemCategoryId(beto.id, 'expense');

    const [got, gotSystem, active, archived, count] = await withUser(
      ana.id,
      async (repos) =>
        [
          await repos.categories.get(betoParent.id),
          await repos.categories.get(betoSystem),
          await repos.categories.tree('expense', 'active'),
          await repos.categories.tree('expense', 'archived'),
          await repos.categories.count(),
        ] as const,
    );

    expect(got).toBeNull();
    expect(gotSystem).toBeNull();
    expect(allIds(active)).not.toContain(betoParent.id);
    expect(allIds(active)).not.toContain(betoChild.id);
    expect(allIds(active)).not.toContain(betoSystem);
    expect(allIds(archived)).not.toContain(betoArchived.id);
    expect(count).toBe(anaCountBefore);
  });

  it('RN-09 update y setOrder no modifican la categoría de otro usuario', async () => {
    const [ana, beto] = await Promise.all([newUser(), newUser()]);
    const anaCategory = await createCategory(ana.id, { sortOrder: 1 });
    const betoCategory = await createCategory(beto.id, { color: 'teal', sortOrder: 9 });

    await withUser(ana.id, (repos) =>
      repos.categories.update(betoCategory.id, { name: 'Robada', color: 'red', icon: 'car' }),
    ).catch(() => undefined);
    await withUser(ana.id, (repos) =>
      repos.categories.setOrder([betoCategory.id, anaCategory.id]),
    ).catch(() => undefined);

    expect(await storedCategory(betoCategory.id)).toMatchObject({
      name: betoCategory.name,
      color: 'teal',
      icon: 'utensils',
      sortOrder: 9,
    });
  });

  it('RN-09 insert no puede colgar una subcategoría de la categoría de otro usuario', async () => {
    const [ana, beto] = await Promise.all([newUser(), newUser()]);
    const betoParent = await createCategory(beto.id);
    const id = uuidv7();

    await expect(
      withUser(ana.id, (repos) =>
        repos.categories.insert({
          id,
          kind: 'expense',
          parentId: betoParent.id,
          name: uniqueCategoryName('Intrusa'),
          color: 'blue',
          icon: 'utensils',
          sortOrder: 1,
        }),
      ),
    ).rejects.toThrow();

    expect(await storedCategory(id)).toBeUndefined();
  });

  it('RN-09 hasMovements, usage e idsWithChildren tratan la categoría de otro usuario como inexistente', async () => {
    const [ana, beto] = await Promise.all([newUser(), newUser()]);
    const betoAccount = await createAccount(beto.id);
    const betoParent = await createCategory(beto.id);
    await createCategory(beto.id, { parentId: betoParent.id });
    await createLedgerTransaction(beto.id, {
      kind: 'expense',
      categoryId: betoParent.id,
      date: '2090-01-10',
      entries: [{ accountId: betoAccount.id, amount: '-10.00' }],
    });
    await createCategoryBudget(beto.id, betoParent.id);
    await createCategoryRule(beto.id, betoParent.id, betoAccount.id);
    await createCategoryShortcut(beto.id, betoParent.id, betoAccount.id);

    const [hasMovements, usage, ids] = await withUser(
      ana.id,
      async (repos) =>
        [
          await repos.categories.hasMovements(betoParent.id),
          await repos.categories.usage(betoParent.id),
          await repos.categories.idsWithChildren(betoParent.id),
        ] as const,
    );

    expect(hasMovements).toBe(false);
    expect(usage.budgets).toEqual([]);
    expect(usage.recurring).toEqual([]);
    expect(usage.shortcuts).toEqual([]);
    expect(ids).toEqual([]);
  });
});
