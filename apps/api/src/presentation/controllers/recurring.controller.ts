import {
  Uuid,
  type ConfirmOccurrenceInput,
  type CreateRuleInput,
  type ResumeInput,
  type UpdateRuleInput,
} from '@finanzas/contracts';
import type { Request, RequestHandler } from 'express';

import { AppError } from '../../application/errors.js';
import type { Clock } from '../../application/ports/clock.js';
import type {
  RecurringContext,
  RecurringService,
} from '../../application/services/recurring.service.js';
import type { SessionContext } from '../middlewares/require-session.js';
import { RecurringPresenter } from '../presenters/recurring.presenter.js';

export interface RecurringControllerDeps {
  recurringService: RecurringService;
  clock: Pick<Clock, 'now'>;
}

export interface RecurringController {
  overview: RequestHandler;
  create: RequestHandler;
  update: RequestHandler;
  pause: RequestHandler;
  skipped: RequestHandler;
  resume: RequestHandler;
  remove: RequestHandler;
  confirm: RequestHandler;
  skip: RequestHandler;
}

const sessionOf = (req: Request): SessionContext => {
  if (req.auth === undefined) {
    throw new AppError('SESSION_EXPIRED');
  }
  return req.auth;
};

const traceIdOf = (locals: Record<string, unknown>): string => {
  const traceId = locals['traceId'];
  return typeof traceId === 'string' ? traceId : '';
};

/** An id that is not a UUID can not be one of the user's rules or occurrences (RNF-14). */
const idOf = (req: Request): string => {
  const parsed = Uuid.safeParse(req.params['id']);
  if (!parsed.success) {
    throw new AppError('NOT_FOUND');
  }
  return parsed.data;
};

/**
 * Handlers of `/api/recurring` (plan §4.14.2). The user always comes from the session, and another
 * user's rule or occurrence answers 404 (RNF-14).
 */
export function createRecurringController({
  recurringService,
  clock,
}: RecurringControllerDeps): RecurringController {
  const contextOf = (req: Request, locals: Record<string, unknown>): RecurringContext => {
    const session = sessionOf(req);
    return {
      userId: session.userId,
      timezone: session.timezone,
      now: clock.now(),
      traceId: traceIdOf(locals),
    };
  };

  return {
    async overview(req, res) {
      const overview = await recurringService.overview(contextOf(req, res.locals));
      res.status(200).json(RecurringPresenter.overview(overview));
    },

    async create(req, res) {
      const { created, rule } = await recurringService.create(
        contextOf(req, res.locals),
        req.body as CreateRuleInput,
      );
      res.status(created ? 201 : 200).json(RecurringPresenter.rule(rule));
    },

    async update(req, res) {
      const rule = await recurringService.update(
        contextOf(req, res.locals),
        idOf(req),
        req.body as UpdateRuleInput,
      );
      res.status(200).json(RecurringPresenter.rule(rule));
    },

    async pause(req, res) {
      await recurringService.pause(contextOf(req, res.locals), idOf(req));
      res.status(204).end();
    },

    async skipped(req, res) {
      const dates = await recurringService.skipped(contextOf(req, res.locals), idOf(req));
      res.status(200).json(RecurringPresenter.skipped(dates));
    },

    async resume(req, res) {
      await recurringService.resume(
        contextOf(req, res.locals),
        idOf(req),
        req.body as ResumeInput,
      );
      res.status(204).end();
    },

    async remove(req, res) {
      await recurringService.remove(contextOf(req, res.locals), idOf(req));
      res.status(204).end();
    },

    async confirm(req, res) {
      const result = await recurringService.confirm(
        contextOf(req, res.locals),
        idOf(req),
        req.body as ConfirmOccurrenceInput,
      );
      res.status(201).json(RecurringPresenter.confirmed(result));
    },

    async skip(req, res) {
      await recurringService.skip(contextOf(req, res.locals), idOf(req));
      res.status(204).end();
    },
  };
}
