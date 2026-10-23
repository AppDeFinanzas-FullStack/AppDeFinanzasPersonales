import {
  Uuid,
  type CreateGoalInput,
  type DedicateInput,
  type EarmarkInput,
  type ReleaseInput,
  type UpdateGoalInput,
} from '@finanzas/contracts';
import type { Request, RequestHandler } from 'express';

import { AppError } from '../../application/errors.js';
import type { Clock } from '../../application/ports/clock.js';
import type { GoalsContext, GoalsService } from '../../application/services/goals.service.js';
import type { SessionContext } from '../middlewares/require-session.js';
import { GoalsPresenter } from '../presenters/goals.presenter.js';

export interface GoalsControllerDeps {
  goalsService: GoalsService;
  clock: Pick<Clock, 'now'>;
}

export interface GoalsController {
  list: RequestHandler;
  get: RequestHandler;
  create: RequestHandler;
  update: RequestHandler;
  earmark: RequestHandler;
  release: RequestHandler;
  dedicate: RequestHandler;
  useAndClose: RequestHandler;
  archive: RequestHandler;
  restore: RequestHandler;
  remove: RequestHandler;
  celebrated: RequestHandler;
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

/** An id that is not a UUID can not be one of the user's goals (RNF-14). */
const idOf = (req: Request): string => {
  const parsed = Uuid.safeParse(req.params['id']);
  if (!parsed.success) {
    throw new AppError('NOT_FOUND');
  }
  return parsed.data;
};

/**
 * Handlers of `/api/goals` (plan §4.12.2). The user always comes from the session, and another
 * user's goal answers 404 (RNF-14).
 */
export function createGoalsController({
  goalsService,
  clock,
}: GoalsControllerDeps): GoalsController {
  const contextOf = (req: Request, locals: Record<string, unknown>): GoalsContext => {
    const session = sessionOf(req);
    return {
      userId: session.userId,
      timezone: session.timezone,
      now: clock.now(),
      traceId: traceIdOf(locals),
    };
  };

  return {
    async list(req, res) {
      const goals = await goalsService.list(contextOf(req, res.locals));
      res.status(200).json(GoalsPresenter.list(goals));
    },

    async get(req, res) {
      const goal = await goalsService.get(contextOf(req, res.locals), idOf(req));
      res.status(200).json(GoalsPresenter.detail(goal));
    },

    async create(req, res) {
      const { created, goal } = await goalsService.create(
        contextOf(req, res.locals),
        req.body as CreateGoalInput,
      );
      res.status(created ? 201 : 200).json(GoalsPresenter.one(goal));
    },

    async update(req, res) {
      const goal = await goalsService.update(
        contextOf(req, res.locals),
        idOf(req),
        req.body as UpdateGoalInput,
      );
      res.status(200).json(GoalsPresenter.one(goal));
    },

    async earmark(req, res, next) {
      try {
        const goal = await goalsService.earmark(
          contextOf(req, res.locals),
          idOf(req),
          req.body as EarmarkInput,
        );
        res.status(201).json(GoalsPresenter.one(goal));
      } catch (error) {
        if (error instanceof AppError && error.code === 'EARMARK_EXCEEDS_FREE') {
          // The free balance travels at the top of the problem as well as in `data` (EC-M12-01).
          const traceId = traceIdOf(res.locals);
          res
            .status(error.status)
            .type('application/problem+json')
            .send(
              JSON.stringify({
                type: `/problems/${error.code}`,
                title: error.code,
                status: error.status,
                code: error.code,
                traceId,
                ...error.data,
                data: error.data,
              }),
            );
          return;
        }
        next(error);
      }
    },

    async release(req, res) {
      const goal = await goalsService.release(
        contextOf(req, res.locals),
        idOf(req),
        req.body as ReleaseInput,
      );
      res.status(200).json(GoalsPresenter.one(goal));
    },

    async dedicate(req, res) {
      const goal = await goalsService.dedicate(
        contextOf(req, res.locals),
        idOf(req),
        req.body as DedicateInput,
      );
      res.status(200).json(GoalsPresenter.one(goal));
    },

    async useAndClose(req, res) {
      const goal = await goalsService.useAndClose(contextOf(req, res.locals), idOf(req));
      res.status(200).json(GoalsPresenter.one(goal));
    },

    async archive(req, res) {
      const goal = await goalsService.archive(contextOf(req, res.locals), idOf(req));
      res.status(200).json(GoalsPresenter.one(goal));
    },

    async restore(req, res) {
      const goal = await goalsService.restore(contextOf(req, res.locals), idOf(req));
      res.status(200).json(GoalsPresenter.one(goal));
    },

    async remove(req, res) {
      await goalsService.remove(contextOf(req, res.locals), idOf(req));
      res.status(204).end();
    },

    async celebrated(req, res) {
      await goalsService.celebrated(contextOf(req, res.locals), idOf(req));
      res.status(204).end();
    },
  };
}
