import {
  Uuid,
  type CreateCategoryInput,
  type MergeInput,
  type ReorderCategoriesInput,
  type RestoreCategoryInput,
  type UpdateCategoryInput,
} from '@finanzas/contracts';
import type { Request, RequestHandler } from 'express';
import { z } from 'zod';

import { AppError } from '../../application/errors.js';
import type {
  CategoryKind,
  CategoryTreeNode,
  LifecycleStatus,
} from '../../application/ports/repositories.js';
import type { CategoriesService } from '../../application/services/categories.service.js';
import { CategoriesPresenter } from '../presenters/categories.presenter.js';

/** The user's categories of a kind and status as a two-level tree. */
export interface CategoryTreeReader {
  tree(userId: string, kind: CategoryKind, status: LifecycleStatus): Promise<CategoryTreeNode[]>;
}

export interface CategoriesControllerDeps {
  categoriesService: CategoriesService;
  categoryTree: CategoryTreeReader;
}

export interface CategoriesController {
  list: RequestHandler;
  create: RequestHandler;
  update: RequestHandler;
  reorder: RequestHandler;
  archiveImpact: RequestHandler;
  archive: RequestHandler;
  restore: RequestHandler;
  remove: RequestHandler;
  mergePreview: RequestHandler;
  merge: RequestHandler;
}

const ListQuery = z.object({
  kind: z.enum(['expense', 'income']),
  status: z.enum(['active', 'archived']).default('active'),
});

const MergePreviewQuery = z.object({ from: Uuid, to: Uuid });

function parseQuery<T>(schema: z.ZodType<T>, query: unknown): T {
  const parsed = schema.safeParse(query);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((issue) => ({
      path: issue.path.map(String).join('.'),
      code: issue.code,
    }));
    throw new AppError('VALIDATION_ERROR', { issues });
  }
  return parsed.data;
}

const userOf = (req: Request): string => {
  if (req.auth === undefined) {
    throw new AppError('SESSION_EXPIRED');
  }
  return req.auth.userId;
};

/** An id that is not a UUID can not be one of the user's categories (RNF-14). */
const idOf = (req: Request): string => {
  const parsed = Uuid.safeParse(req.params['id']);
  if (!parsed.success) {
    throw new AppError('CATEGORY_NOT_FOUND');
  }
  return parsed.data;
};

/**
 * Handlers of `/api/categories` (plan §4.5.2). The bodies were validated by the router; the user
 * always comes from the session, and another user's category answers 404 (RN-09, RNF-14).
 */
export function createCategoriesController({
  categoriesService,
  categoryTree,
}: CategoriesControllerDeps): CategoriesController {
  return {
    async list(req, res) {
      const { kind, status } = parseQuery(ListQuery, req.query);
      const roots = await categoryTree.tree(userOf(req), kind, status);
      res.status(200).json(CategoriesPresenter.tree(roots));
    },

    async create(req, res) {
      const { created, category } = await categoriesService.create(
        userOf(req),
        req.body as CreateCategoryInput,
      );
      res.status(created ? 201 : 200).json(CategoriesPresenter.category(category));
    },

    async update(req, res) {
      const category = await categoriesService.update(
        userOf(req),
        idOf(req),
        req.body as UpdateCategoryInput,
      );
      res.status(200).json(CategoriesPresenter.category(category));
    },

    async reorder(req, res) {
      await categoriesService.reorder(userOf(req), req.body as ReorderCategoriesInput);
      res.status(204).end();
    },

    async archiveImpact(req, res) {
      res.status(200).json(await categoriesService.archiveImpact(userOf(req), idOf(req)));
    },

    async archive(req, res) {
      await categoriesService.archive(userOf(req), idOf(req));
      res.status(204).end();
    },

    async restore(req, res) {
      await categoriesService.restore(userOf(req), idOf(req), req.body as RestoreCategoryInput);
      res.status(204).end();
    },

    async remove(req, res) {
      await categoriesService.remove(userOf(req), idOf(req));
      res.status(204).end();
    },

    async mergePreview(req, res) {
      const { from, to } = parseQuery(MergePreviewQuery, req.query);
      res
        .status(200)
        .json(await categoriesService.mergePreview(userOf(req), { fromId: from, toId: to }));
    },

    async merge(req, res) {
      await categoriesService.merge(userOf(req), req.body as MergeInput);
      res.status(204).end();
    },
  };
}
