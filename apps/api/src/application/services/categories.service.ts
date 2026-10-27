import type {
  ArchiveImpactDto,
  CreateCategoryInput,
  MergeInput,
  MergePreviewDto,
  ReorderCategoriesInput,
  RestoreCategoryInput,
  UpdateCategoryInput,
} from '@finanzas/contracts';
import { BOLIVIA_TIME_ZONE } from '@finanzas/domain';

import { AppError } from '../errors.js';
import type { Clock } from '../ports/clock.js';
import type {
  CategoryKind,
  CategoryPatch,
  CategoryRow,
  Repositories,
} from '../ports/repositories.js';
import type { UnitOfWork } from '../ports/unit-of-work.js';
import type { NotificationEmitter } from '../shared/notification-emitter.js';
import type { UserTimezones } from '../shared/recurring-generator.js';
import { pauseRulesWithNotice } from './accounts.service.js';

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
  /** What archiving the category affects (RF-M5-07). */
  archiveImpact(userId: string, id: string): Promise<ArchiveImpactDto>;
  /**
   * Archives the category and its subcategories; the history stays (RF-M5-06). Their active rules
   * are paused with a notice to choose another category (RF-M5-07).
   */
  archive(userId: string, id: string): Promise<void>;
  /** Restores the category and the chosen subcategories, optionally renaming it (EC-M5-04). */
  restore(userId: string, id: string, input: RestoreCategoryInput): Promise<void>;
  /**
   * Deletes the category and its subcategories when none has movements or a budget or rule that
   * uses it (RN-08, EC-M5-07); their shortcuts go with them.
   */
  remove(userId: string, id: string): Promise<void>;
  /** What merging A into B would move (RF-M5-08). */
  mergePreview(userId: string, input: MergeInput): Promise<MergePreviewDto>;
  /**
   * Moves the movements, rules, shortcuts and budget of A to B and deletes A (RF-M5-08, RF-M5-09);
   * `budgetEffect` is the warning of what happened to the budget of A.
   */
  merge(userId: string, input: MergeInput): Promise<{ budgetEffect: BudgetEffect }>;
}

type BudgetEffect = MergePreviewDto['budgetEffect'];

/**
 * The budget repositories of the transaction, `null` in a unit of work wired without the budgets
 * module (M11, V1.1), where no category can have a budget.
 */
function budgetReposOf(
  repos: Repositories,
): Pick<Repositories, 'budgets' | 'budgetPeriods'> | null {
  const { budgets, budgetPeriods } = repos as Partial<Repositories>;
  return budgets === undefined || budgetPeriods === undefined ? null : { budgets, budgetPeriods };
}

/** What a merge of A into B does to their budgets (RF-M5-08). */
async function budgetEffectOf(
  budgetRepos: Pick<Repositories, 'budgets'> | null,
  { fromId, toId }: MergeInput,
): Promise<{ effect: BudgetEffect; fromBudgetId: string | null }> {
  const fromBudgetId = budgetRepos === null ? null : await budgetRepos.budgets.findLive(fromId);
  if (budgetRepos === null || fromBudgetId === null) {
    return { effect: 'none', fromBudgetId: null };
  }
  const toBudgetId = await budgetRepos.budgets.findLive(toId);
  return { effect: toBudgetId === null ? 'moved' : 'kept_target', fromBudgetId };
}

export interface CategoriesServiceDeps {
  uow: UnitOfWork;
  /**
   * The recurring rules (M14): archiving pauses them with a notice dated in the zone of the user.
   * Without it the service does not touch rules.
   */
  recurring?: { notifications: NotificationEmitter; timezones: UserTimezones; clock: Clock };
}

/** Checks a merge of A into B: same kind, A without children, B active, neither a system one. */
async function requireMergeable(
  repos: Repositories,
  { fromId, toId }: MergeInput,
): Promise<{ from: CategoryRow; to: CategoryRow }> {
  const from = await repos.categories.get(fromId);
  const to = await repos.categories.get(toId);
  if (from === null || to === null) {
    throw new AppError('CATEGORY_NOT_FOUND');
  }
  const invalid = (reason: string): AppError => new AppError('MERGE_INVALID', { reason });
  if (fromId === toId) {
    throw invalid('same_category');
  }
  if (from.isSystem || to.isSystem) {
    throw invalid('system_category');
  }
  if (from.kind !== to.kind) {
    throw invalid('different_kind');
  }
  if (to.status !== 'active') {
    throw invalid('target_archived');
  }
  const children = [
    ...(await repos.categories.children(fromId, 'active')),
    ...(await repos.categories.children(fromId, 'archived')),
  ];
  if (children.length > 0) {
    throw invalid('source_has_children');
  }
  return { from, to };
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

export function createCategoriesService({
  uow,
  recurring,
}: CategoriesServiceDeps): CategoriesService {
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

    async archiveImpact(userId, id) {
      return uow.run(
        async (repos) => {
          const current = await repos.categories.get(id);
          if (current === null) {
            throw new AppError('CATEGORY_NOT_FOUND');
          }
          const children = await repos.categories.children(id, 'active');
          const budgets: { id: string }[] = [];
          const recurring: { id: string; name: string }[] = [];
          const shortcuts: { id: string; name: string }[] = [];
          // Archiving the parent archives its active children, so their usage is affected too.
          for (const affectedId of [id, ...children.map((child) => child.id)]) {
            const usage = await repos.categories.usage(affectedId);
            budgets.push(...usage.budgets);
            recurring.push(...usage.recurring);
            shortcuts.push(...usage.shortcuts);
          }
          return {
            children: children.map((child) => ({ id: child.id, name: child.name })),
            budgets,
            recurring,
            shortcuts,
          };
        },
        { userLock: userId },
      );
    },

    async archive(userId, id) {
      // "Today" of the pause is the date in the zone of the user's profile (RN-07).
      const today =
        recurring === undefined
          ? null
          : recurring.clock.todayFor(
              (await recurring.timezones.timezoneOf(userId)) ?? BOLIVIA_TIME_ZONE,
            );
      await uow.run(
        async (repos) => {
          const current = await repos.categories.get(id);
          if (current === null) {
            throw new AppError('CATEGORY_NOT_FOUND');
          }
          if (current.isSystem) {
            throw new AppError('SYSTEM_CATEGORY');
          }
          const children = await repos.categories.children(id, 'active');
          const ids = children.map((child) => child.id);
          if (current.status === 'active') {
            ids.push(id);
          }
          await repos.categories.setStatus(ids, 'archived');
          if (recurring !== undefined && today !== null) {
            const archived = new Set(ids);
            await pauseRulesWithNotice(repos, recurring.notifications, {
              userId,
              uses: (rule) =>
                rule.status === 'active' && rule.categoryId !== null && archived.has(rule.categoryId),
              reason: 'category_archived',
              now: recurring.clock.now(),
              today,
            });
          }
          // The budget lasts until the end of its period; a pending decision stays (EC-M11-04).
          await budgetReposOf(repos)?.budgets.finalizeForCategories(ids);
        },
        { userLock: userId },
      );
    },

    async restore(userId, id, input) {
      await uow.run(
        async (repos) => {
          const current = await repos.categories.get(id);
          if (current === null) {
            throw new AppError('CATEGORY_NOT_FOUND');
          }
          if (current.parentId !== null) {
            const parent = await repos.categories.get(current.parentId);
            if (parent !== null && parent.status !== 'active') {
              throw new AppError('PARENT_ARCHIVED');
            }
          }

          const name = input.newName?.trim() ?? current.name;
          await assertNameFree(repos, current.kind, current.parentId, name, id);
          if (name !== current.name) {
            await repos.categories.update(id, { name });
          }
          await repos.categories.setStatus([id], 'active');

          const archivedChildren = await repos.categories.children(id, 'archived');
          for (const childId of input.childIds) {
            const child = archivedChildren.find((candidate) => candidate.id === childId);
            if (child === undefined) {
              throw new AppError('HIERARCHY_INVALID');
            }
            await assertNameFree(repos, child.kind, id, child.name, childId);
            await repos.categories.setStatus([childId], 'active');
          }
        },
        { userLock: userId },
      );
    },

    async remove(userId, id) {
      await uow.run(
        async (repos) => {
          const current = await repos.categories.get(id);
          if (current === null) {
            throw new AppError('CATEGORY_NOT_FOUND');
          }
          if (current.isSystem) {
            throw new AppError('SYSTEM_CATEGORY');
          }
          const ids = await repos.categories.idsWithChildren(id);
          const budgets: { id: string }[] = [];
          const recurring: { id: string; name: string }[] = [];
          for (const affectedId of ids) {
            if (await repos.categories.hasMovements(affectedId)) {
              throw new AppError('CATEGORY_HAS_MOVEMENTS');
            }
            const usage = await repos.categories.usage(affectedId);
            budgets.push(...usage.budgets);
            recurring.push(...usage.recurring);
          }
          if (budgets.length > 0 || recurring.length > 0) {
            throw new AppError('CATEGORY_IN_USE', { budgets, recurring });
          }
          await repos.categories.remove(ids);
        },
        { userLock: userId },
      );
    },

    async mergePreview(userId, input) {
      return uow.run(
        async (repos) => {
          await requireMergeable(repos, input);
          const { effect } = await budgetEffectOf(budgetReposOf(repos), input);
          return {
            movements: await repos.categories.countMovements(input.fromId),
            budgetEffect: effect,
          };
        },
        { userLock: userId },
      );
    },

    async merge(userId, input) {
      return uow.run(
        async (repos) => {
          await requireMergeable(repos, input);
          const budgetRepos = budgetReposOf(repos);
          if (await budgetRepos?.budgetPeriods.hasPendingCloseInCategory(input.fromId)) {
            throw new AppError('MERGE_PENDING_CLOSE');
          }
          const { effect, fromBudgetId } = await budgetEffectOf(budgetRepos, input);
          if (budgetRepos !== null) {
            // Both had a budget: B keeps its own and the one of A goes, with its periods.
            if (effect === 'kept_target' && fromBudgetId !== null) {
              await budgetRepos.budgets.delete(fromBudgetId);
            }
            await budgetRepos.budgets.moveToCategory(input.fromId, input.toId);
          }
          await repos.categories.moveUsage(input.fromId, input.toId);
          await repos.categories.remove([input.fromId]);
          return { budgetEffect: effect };
        },
        { userLock: userId },
      );
    },
  };
}
