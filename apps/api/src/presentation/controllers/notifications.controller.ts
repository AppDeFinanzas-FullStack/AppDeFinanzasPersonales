import { NotificationsQuery, Uuid } from '@finanzas/contracts';
import type { Request, RequestHandler } from 'express';
import { z } from 'zod';

import { AppError } from '../../application/errors.js';
import type { NotificationsService } from '../../application/services/notifications.service.js';
import { NotificationsPresenter } from '../presenters/notifications.presenter.js';

export interface NotificationsControllerDeps {
  notificationsService: NotificationsService;
}

export interface NotificationsController {
  list: RequestHandler;
  unreadCount: RequestHandler;
  markRead: RequestHandler;
  markAllRead: RequestHandler;
  remove: RequestHandler;
}

/** `NotificationsQuery` read from the query string, where the limit arrives as text. */
const ListQuery = NotificationsQuery.extend({
  limit: z.coerce.number().int().min(1).max(50).default(20),
});

const userOf = (req: Request): string => {
  if (req.auth === undefined) {
    throw new AppError('SESSION_EXPIRED');
  }
  return req.auth.userId;
};

/** An id that is not a UUID can not be one of the user's notifications (RNF-14). */
const idOf = (req: Request): string => {
  const parsed = Uuid.safeParse(req.params['id']);
  if (!parsed.success) {
    throw new AppError('NOT_FOUND');
  }
  return parsed.data;
};

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

/**
 * Handlers of `/api/notifications` (plan §4.15.2). The user always comes from the session, and
 * another user's notification answers 404 (RN-09, RNF-14).
 */
export function createNotificationsController({
  notificationsService,
}: NotificationsControllerDeps): NotificationsController {
  return {
    async list(req, res) {
      const query = parseQuery(ListQuery, req.query);
      const page = await notificationsService.list(userOf(req), query);
      res.status(200).json(NotificationsPresenter.page(page));
    },

    async unreadCount(req, res) {
      const count = await notificationsService.unreadCount(userOf(req));
      res.status(200).json(NotificationsPresenter.unreadCount(count));
    },

    async markRead(req, res) {
      await notificationsService.markRead(userOf(req), idOf(req));
      res.status(204).end();
    },

    async markAllRead(req, res) {
      await notificationsService.markAllRead(userOf(req));
      res.status(204).end();
    },

    async remove(req, res) {
      await notificationsService.remove(userOf(req), idOf(req));
      res.status(204).end();
    },
  };
}
