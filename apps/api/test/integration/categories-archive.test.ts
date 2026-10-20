import { afterAll, describe, expect, it } from 'vitest';

import { AppError } from '../../src/application/errors.js';
import type { Repositories } from '../../src/application/ports/repositories.js';
import type { UnitOfWork } from '../../src/application/ports/unit-of-work.js';
import { createCategoryRepository } from '../../src/infrastructure/persistence/repositories/category.repository.js';
import { createLedgerRepository } from '../../src/infrastructure/persistence/repositories/ledger.repository.js';
import { createUnitOfWork } from '../../src/infrastructure/persistence/unit-of-work.js';
import { createAccount } from '../factories/account.factory.js';
import {
  createCategory,
  createCategoryShortcut,
  deleteCategoryUsageOf,
  uniqueCategoryName,
} from '../factories/category.factory.js';
import { createLedgerTransaction, deleteLedgerOf } from '../factories/ledger.factory.js';
import { createUser, deleteCreatedUsers } from '../factories/user.factory.js';
import { disconnectTestPrisma, testPrisma } from './setup/db.js';

/**
 * The plan fixes the endpoints (plan §4.5.2) and their errors, the input `RestoreCategoryInput` and
 * the output `ArchiveImpactDto` (`@finanzas/contracts`). It does not fix the signatures. These
 * tests assume, like the rest of `CategoriesService`:
 * - `archiveImpact(userId, id)` resolves to `{ children, budgets, recurring, shortcuts }`.
 * - `archive(userId, id)` archives the category and its subcategories.
 * - `restore(userId, id, { childIds, newName? })` restores the category and the chosen
 *   subcategories; `newName` renames the restored category.
 * - A rejection is an `AppError` with the code of the catalogue (ADR-09). A category of another
 *   user does not exist for the user (RNF-14): a 404.
 */
interface ArchiveImpact {
  children: { id: string; name: string }[];
  budgets: { id: string }[];
  recurring: { id: string; name: string }[];
  shortcuts: { id: string; name: string }[];
}

interface CategoriesServiceUnderTest {
  archiveImpact(userId: string, id: string): Promise<ArchiveImpact>;
  archive(userId: string, id: string): Promise<unknown>;
  restore(
    userId: string,
    id: string,
    input: { childIds: string[]; newName?: string },
  ): Promise<unknown>;
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
  await deleteCategoryUsageOf(usedUserIds);
  await deleteLedgerOf(usedUserIds);
  await deleteCreatedUsers();
  await disconnectTestPrisma();
});

async function newUserId(): Promise<string> {
  const user = await createUser();
  usedUserIds.push(user.id);
  return user.id;
}

const withUser = <T>(userId: string, fn: (repos: Repositories) => Promise<T>) =>
  uow.run(fn, { userLock: userId });

async function rejectionOf(promise: Promise<unknown>): Promise<AppError> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(AppError);
    return error as AppError;
  }
  throw new Error('Expected the promise to be rejected');
}

async function statusOf(userId: string, id: string): Promise<string | undefined> {
  const rows = await prisma.$queryRaw<{ status: string }[]>`
    SELECT status::text AS status FROM category
     WHERE user_id = ${userId}::uuid AND id = ${id}::uuid`;
  return rows[0]?.status;
}

async function nameOf(userId: string, id: string): Promise<string | undefined> {
  const rows = await prisma.$queryRaw<{ name: string }[]>`
    SELECT name FROM category WHERE user_id = ${userId}::uuid AND id = ${id}::uuid`;
  return rows[0]?.name;
}

/** Archives rows directly: the guard trigger forbids inserting a child under an archived parent. */
async function forceArchive(userId: string, ids: string[]): Promise<void> {
  for (const id of ids) {
    await prisma.$executeRaw`
      UPDATE category SET status = 'archived', archived_at = now()
       WHERE user_id = ${userId}::uuid AND id = ${id}::uuid`;
  }
}

async function systemCategoryId(userId: string): Promise<string> {
  const rows = await prisma.$queryRaw<{ id: string }[]>`
    SELECT id::text AS id FROM category
     WHERE user_id = ${userId}::uuid AND is_system = true AND parent_id IS NULL
     LIMIT 1`;
  const id = rows[0]?.id;
  if (!id) {
    throw new Error('The user has no system category');
  }
  return id;
}

// ---------- archiveImpact ----------

describe('CategoriesService.archiveImpact', () => {
  it('RF-M5-07 el impacto lista las hijas y los atajos afectados', async () => {
    const userId = await newUserId();
    const account = await createAccount(userId);
    const parent = await createCategory(userId);
    const child = await createCategory(userId, { parentId: parent.id });
    const shortcut = await createCategoryShortcut(userId, parent.id, account.id);

    const impact = await service.archiveImpact(userId, parent.id);

    expect(impact.children).toEqual([{ id: child.id, name: child.name }]);
    expect(impact.shortcuts).toEqual([{ id: shortcut.id, name: shortcut.name }]);
    expect(impact.budgets).toEqual([]);
    expect(impact.recurring).toEqual([]);
  });

  it('RF-M5-07 el impacto del padre incluye los atajos de sus hijas', async () => {
    const userId = await newUserId();
    const account = await createAccount(userId);
    const parent = await createCategory(userId);
    const child = await createCategory(userId, { parentId: parent.id });
    const shortcut = await createCategoryShortcut(userId, child.id, account.id);

    const impact = await service.archiveImpact(userId, parent.id);

    expect(impact.children).toEqual([{ id: child.id, name: child.name }]);
    expect(impact.shortcuts).toEqual([{ id: shortcut.id, name: shortcut.name }]);
  });

  it('RF-M5-07 una categoría sin uso ni hijas no tiene impacto', async () => {
    const userId = await newUserId();
    const parent = await createCategory(userId);

    const impact = await service.archiveImpact(userId, parent.id);

    expect(impact).toEqual({ children: [], budgets: [], recurring: [], shortcuts: [] });
  });

  it('TASK-112 el impacto de la categoría de otro usuario no existe', async () => {
    const userId = await newUserId();
    const otherId = await newUserId();
    const foreign = await createCategory(otherId);

    const error = await rejectionOf(service.archiveImpact(userId, foreign.id));

    expect(error.status).toBe(404);
  });
});

// ---------- archive ----------

describe('CategoriesService.archive', () => {
  it('RF-M5-06 archiva el padre y sus hijas', async () => {
    const userId = await newUserId();
    const parent = await createCategory(userId);
    const child = await createCategory(userId, { parentId: parent.id });

    await service.archive(userId, parent.id);

    expect(await statusOf(userId, parent.id)).toBe('archived');
    expect(await statusOf(userId, child.id)).toBe('archived');
  });

  it('RF-M5-06 una archivada no aparece en el árbol de activas y conserva sus movimientos', async () => {
    const userId = await newUserId();
    const account = await createAccount(userId, { initialBalanceDate: '2090-01-01' });
    const parent = await createCategory(userId);
    const child = await createCategory(userId, { parentId: parent.id });
    const sibling = await createCategory(userId);
    await createLedgerTransaction(userId, {
      kind: 'expense',
      date: '2090-06-10',
      categoryId: child.id,
      entries: [{ accountId: account.id, amount: '-10.00' }],
    });

    await service.archive(userId, parent.id);

    const seen = await withUser(userId, async (repos) => {
      const active = await repos.categories.tree('expense', 'active');
      const archived = await repos.categories.tree('expense', 'archived');
      return {
        active: active.flatMap((node) => [node.id, ...node.children.map((c) => c.id)]),
        archived: archived.flatMap((node) => [node.id, ...node.children.map((c) => c.id)]),
        hasMovements: await repos.categories.hasMovements(child.id),
      };
    });
    expect(seen.active).not.toContain(parent.id);
    expect(seen.active).not.toContain(child.id);
    expect(seen.active).toContain(sibling.id);
    expect(seen.archived).toContain(parent.id);
    expect(seen.hasMovements).toBe(true);
  });

  it('RF-M5-06 archivar una hija deja activo al padre', async () => {
    const userId = await newUserId();
    const parent = await createCategory(userId);
    const child = await createCategory(userId, { parentId: parent.id });

    await service.archive(userId, child.id);

    expect(await statusOf(userId, child.id)).toBe('archived');
    expect(await statusOf(userId, parent.id)).toBe('active');
  });

  it('RF-M5-07 los atajos de la archivada siguen existiendo para reaparecer al restaurarla', async () => {
    const userId = await newUserId();
    const account = await createAccount(userId);
    const parent = await createCategory(userId);
    const shortcut = await createCategoryShortcut(userId, parent.id, account.id);

    await service.archive(userId, parent.id);

    const usage = await withUser(userId, (repos) => repos.categories.usage(parent.id));
    expect(usage.shortcuts).toEqual([{ id: shortcut.id, name: shortcut.name }]);
  });

  it('TASK-112 una categoría del sistema no se archiva', async () => {
    const userId = await newUserId();
    const systemId = await systemCategoryId(userId);

    const error = await rejectionOf(service.archive(userId, systemId));

    expect(error.code).toBe('SYSTEM_CATEGORY');
    expect(error.status).toBe(422);
    expect(await statusOf(userId, systemId)).toBe('active');
  });

  it('TASK-112 no archiva la categoría de otro usuario', async () => {
    const userId = await newUserId();
    const otherId = await newUserId();
    const foreign = await createCategory(otherId);

    const error = await rejectionOf(service.archive(userId, foreign.id));

    expect(error.status).toBe(404);
    expect(await statusOf(otherId, foreign.id)).toBe('active');
  });
});

// ---------- restore ----------

describe('CategoriesService.restore', () => {
  it('RF-M5-06 restaura el padre y las hijas elegidas, y deja archivadas las demás', async () => {
    const userId = await newUserId();
    const parent = await createCategory(userId);
    const chosen = await createCategory(userId, { parentId: parent.id });
    const left = await createCategory(userId, { parentId: parent.id });
    await forceArchive(userId, [chosen.id, left.id, parent.id]);

    await service.restore(userId, parent.id, { childIds: [chosen.id] });

    expect(await statusOf(userId, parent.id)).toBe('active');
    expect(await statusOf(userId, chosen.id)).toBe('active');
    expect(await statusOf(userId, left.id)).toBe('archived');
  });

  it('EC-M5-04 restaurar con un nombre en uso da NAME_TAKEN', async () => {
    const userId = await newUserId();
    const name = uniqueCategoryName('Comida');
    await createCategory(userId, { name });
    const archived = await createCategory(userId, { name, status: 'archived' });

    const error = await rejectionOf(service.restore(userId, archived.id, { childIds: [] }));

    expect(error.code).toBe('NAME_TAKEN');
    expect(error.status).toBe(409);
    expect(await statusOf(userId, archived.id)).toBe('archived');
  });

  it('EC-M5-04 restaurar con un nombre nuevo la restaura renombrada', async () => {
    const userId = await newUserId();
    const name = uniqueCategoryName('Comida');
    await createCategory(userId, { name });
    const archived = await createCategory(userId, { name, status: 'archived' });
    const newName = uniqueCategoryName('Almuerzo');

    await service.restore(userId, archived.id, { childIds: [], newName });

    expect(await statusOf(userId, archived.id)).toBe('active');
    expect(await nameOf(userId, archived.id)).toBe(newName);
  });

  it('EC-M5-06 restaurar una hija con el padre archivado da PARENT_ARCHIVED', async () => {
    const userId = await newUserId();
    const parent = await createCategory(userId);
    const child = await createCategory(userId, { parentId: parent.id });
    await forceArchive(userId, [child.id, parent.id]);

    const error = await rejectionOf(service.restore(userId, child.id, { childIds: [] }));

    expect(error.code).toBe('PARENT_ARCHIVED');
    expect(error.status).toBe(409);
    expect(await statusOf(userId, child.id)).toBe('archived');
    expect(await statusOf(userId, parent.id)).toBe('archived');
  });

  it('EC-M5-06 restaurar una hija con el padre activo la restaura', async () => {
    const userId = await newUserId();
    const parent = await createCategory(userId);
    const child = await createCategory(userId, { parentId: parent.id, status: 'archived' });

    await service.restore(userId, child.id, { childIds: [] });

    expect(await statusOf(userId, child.id)).toBe('active');
  });

  it('TASK-112 no restaura la categoría de otro usuario', async () => {
    const userId = await newUserId();
    const otherId = await newUserId();
    const foreign = await createCategory(otherId, { status: 'archived' });

    const error = await rejectionOf(service.restore(userId, foreign.id, { childIds: [] }));

    expect(error.status).toBe(404);
    expect(await statusOf(otherId, foreign.id)).toBe('archived');
  });
});
