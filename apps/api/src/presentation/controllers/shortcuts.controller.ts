import {
  Uuid,
  type CreateShortcutInput,
  type ReorderShortcutsInput,
  type UpdateShortcutInput,
} from '@finanzas/contracts';
import type { Request, RequestHandler } from 'express';

import { AppError } from '../../application/errors.js';
import type { ShortcutsService } from '../../application/services/shortcuts.service.js';
import { ShortcutsPresenter } from '../presenters/shortcuts.presenter.js';

export interface ShortcutsControllerDeps {
  shortcutsService: ShortcutsService;
}

export interface ShortcutsController {
  list: RequestHandler;
  create: RequestHandler;
  update: RequestHandler;
  reorder: RequestHandler;
  remove: RequestHandler;
}

const userOf = (req: Request): string => {
  if (req.auth === undefined) {
    throw new AppError('SESSION_EXPIRED');
  }
  return req.auth.userId;
};

/** An id that is not a UUID can not be one of the user's shortcuts (RNF-14). */
const idOf = (req: Request): string => {
  const parsed = Uuid.safeParse(req.params['id']);
  if (!parsed.success) {
    throw new AppError('NOT_FOUND');
  }
  return parsed.data;
};

/**
 * Handlers of `/api/shortcuts` (plan §4.7.2). The bodies were validated by the router; the user
 * always comes from the session, and another user's shortcut answers 404 (RN-09).
 */
export function createShortcutsController({
  shortcutsService,
}: ShortcutsControllerDeps): ShortcutsController {
  return {
    async list(req, res) {
      const shortcuts = await shortcutsService.list(userOf(req));
      res.status(200).json(ShortcutsPresenter.list(shortcuts));
    },

    async create(req, res) {
      const { created, shortcut } = await shortcutsService.create(
        userOf(req),
        req.body as CreateShortcutInput,
      );
      res.status(created ? 201 : 200).json(ShortcutsPresenter.toDto(shortcut));
    },

    async update(req, res) {
      const shortcut = await shortcutsService.update(
        userOf(req),
        idOf(req),
        req.body as UpdateShortcutInput,
      );
      res.status(200).json(ShortcutsPresenter.toDto(shortcut));
    },

    async reorder(req, res) {
      await shortcutsService.reorder(userOf(req), req.body as ReorderShortcutsInput);
      res.status(204).end();
    },

    async remove(req, res) {
      await shortcutsService.remove(userOf(req), idOf(req));
      res.status(204).end();
    },
  };
}
