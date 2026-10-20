import type {
  CreateCategoryInput,
  ReorderCategoriesInput,
  UpdateCategoryInput,
} from '@finanzas/contracts';

import { AppError } from '../errors.js';
import type {
  CategoryKind,
  CategoryPatch,
  CategoryRow,
  Repositories,
} from '../ports/repositories.js';
import type { UnitOfWork } from '../ports/unit-of-work.js';

/** Maximum categories per user (RNF-28). */
const CATEGORY_LIMIT = 300;
/** Color of a main category created without one. */
const DEFAULT_COLOR = 'blue';

export interface CategoriesService {
  /** Idempotent by `input.id`: `created` is `false` when the category already existed (ADR-11). */
  create(
    userId: string,
    input: CreateCategoryInput,
  ): Promise<{ created: boolean; category: CategoryRow }>;
  update(userId: string, id: string, input: UpdateCategoryInput): Promise<CategoryRow>;
  /** Reassigns `sortOrder` within the same kind and parent. */
  reorder(userId: string, input: ReorderCategoriesInput): Promise<void>;
}

/** The parent of a category being created or moved must exist, be a root, of the same kind and active. */
async function requireValidParent(
  repos: Repositories,
  parentId: string,
  kind: CategoryKind,
): Promise<CategoryRow> {
  const parent = await repos.categories.get(parentId);
  if (parent === null) {
    throw new AppError('CATEGORY_NOT_FOUND');
  }
  if (parent.parentId !== null || parent.kind !== kind) {
    throw new AppError('HIERARCHY_INVALID');
  }
  if (parent.status !== 'active') {
    throw new AppError('PARENT_ARCHIVED');
  }
  return parent;
}

/** Rejects a name already used, ignoring case, by another active sibling (RF-M5-02). */
async function assertNameFree(
  repos: Repositories,
  kind: CategoryKind,
  parentId: string | null,
  name: string,
  selfId: string | null,
): Promise<void> {
  const roots = await repos.categories.tree(kind, 'active');
  const siblings =
    parentId === null ? roots : (roots.find((root) => root.id === parentId)?.children ?? []);
  const wanted = name.toLowerCase();
  if (siblings.some((node) => node.id !== selfId && node.name.toLowerCase() === wanted)) {
    throw new AppError('NAME_TAKEN');
  }
}

export function createCategoriesService({ uow }: { uow: UnitOfWork }): CategoriesService {
  return {
    async create(userId, input) {
      return uow.run(
        async (repos) => {
          const existing = await repos.categories.get(input.id);
          if (existing !== null) {
            return { created: false, category: existing };
          }
          const count = await repos.categories.count();
          if (count >= CATEGORY_LIMIT) {
            throw new AppError('LIMIT_REACHED');
          }

          const name = input.name.trim();
          let color: string = input.color ?? DEFAULT_COLOR;
          if (input.parentId !== null) {
            const parent = await requireValidParent(repos, input.parentId, input.kind);
            color = input.color ?? parent.color;
          }
          await assertNameFree(repos, input.kind, input.parentId, name, null);

          await repos.categories.insert({
            id: input.id,
            kind: input.kind,
            parentId: input.parentId,
            name,
            color,
            icon: input.icon,
            sortOrder: count,
          });
          const category = await repos.categories.get(input.id);
          if (category === null) {
            throw new AppError('INTERNAL_ERROR');
          }
          return { created: true, category };
        },
        { userLock: userId },
      );
    },

    async update(userId, id, input) {
      return uow.run(
        async (repos) => {
          const current = await repos.categories.get(id);
          if (current === null) {
            throw new AppError('CATEGORY_NOT_FOUND');
          }

          const name = input.name?.trim();
          const renames = name !== undefined && name !== current.name;
          const moves = input.parentId !== undefined && input.parentId !== current.parentId;
          if (current.isSystem && (renames || moves)) {
            throw new AppError('SYSTEM_CATEGORY');
          }

          if (moves && input.parentId !== undefined && input.parentId !== null) {
            if (input.parentId === id) {
              throw new AppError('HIERARCHY_INVALID');
            }
            await requireValidParent(repos, input.parentId, current.kind);
            if ((await repos.categories.idsWithChildren(id)).length > 1) {
              throw new AppError('HIERARCHY_INVALID');
            }
          }

          if ((renames || moves) && current.status === 'active') {
            const parentId = input.parentId === undefined ? current.parentId : input.parentId;
            await assertNameFree(repos, current.kind, parentId, name ?? current.name, id);
          }

          const patch: CategoryPatch = {};
          if (renames) patch.name = name;
          if (input.color !== undefined) patch.color = input.color;
          if (input.icon !== undefined) patch.icon = input.icon;
          if (moves) patch.parentId = input.parentId ?? null;
          await repos.categories.update(id, patch);

          const updated = await repos.categories.get(id);
          if (updated === null) {
            throw new AppError('INTERNAL_ERROR');
          }
          return updated;
        },
        { userLock: userId },
      );
    },

    async reorder(userId, input) {
      await uow.run(
        async (repos) => {
          const movable: string[] = [];
          for (const id of input.ids) {
            const row = await repos.categories.get(id);
            if (row === null) {
              throw new AppError('CATEGORY_NOT_FOUND');
            }
            if (row.kind !== input.kind || row.parentId !== input.parentId) {
              throw new AppError('HIERARCHY_INVALID');
            }
            // A system category keeps its position: the guard only lets it change color and icon.
            if (!row.isSystem) {
              movable.push(id);
            }
          }
          await repos.categories.setOrder(movable);
        },
        { userLock: userId },
      );
    },
  };
}
