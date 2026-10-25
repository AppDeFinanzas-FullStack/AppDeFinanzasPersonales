import {
  Uuid,
  type CreateBudgetInput,
  type DecisionInput,
  type UpdateBudgetInput,
} from '@finanzas/contracts';
import type { Request, RequestHandler, Response } from 'express';

import { AppError } from '../../application/errors.js';
import type { Clock } from '../../application/ports/clock.js';
import type {
  BudgetsContext,
  BudgetsService,
} from '../../application/services/budgets.service.js';
import type { SessionContext } from '../middlewares/require-session.js';
import { BudgetsPresenter } from '../presenters/budgets.presenter.js';

export interface BudgetsControllerDeps {
  budgetsService: BudgetsService;
  clock: Pick<Clock, 'now'>;
}

export interface BudgetsController {
  list: RequestHandler;
  get: RequestHandler;
  create: RequestHandler;
  update: RequestHandler;
  pause: RequestHandler;
  resume: RequestHandler;
  resetCarryover: RequestHandler;
  remove: RequestHandler;
  decide: RequestHandler;
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

/** An id that is not a UUID can not be one of the user's budgets or periods (RNF-14). */
const uuidParam = (req: Request, name: string): string => {
  const parsed = Uuid.safeParse(req.params[name]);
  if (!parsed.success) {
    throw new AppError('NOT_FOUND');
  }
  return parsed.data;
};

/** `BUDGET_EXISTS` carries the existing `budgetId` at the top of the problem (EC-M11-06). */
const sendBudgetExists = (res: Response, error: AppError): void => {
  res
    .status(error.status)
    .type('application/problem+json')
    .send(
      JSON.stringify({
        type: `/problems/${error.code}`,
        title: error.code,
        status: error.status,
        code: error.code,
        traceId: traceIdOf(res.locals),
        ...error.data,
        data: error.data,
      }),
    );
};

/**
 * Handlers of `/api/budgets` (plan §4.11.2). The user always comes from the session, and another
 * user's budget or period answers 404 (RNF-14).
 */
export function createBudgetsController({
  budgetsService,
  clock,
}: BudgetsControllerDeps): BudgetsController {
  const contextOf = (req: Request, locals: Record<string, unknown>): BudgetsContext => {
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
      const budgets = await budgetsService.list(contextOf(req, res.locals));
      res.status(200).json(BudgetsPresenter.list(budgets));
    },

    async get(req, res) {
      const budget = await budgetsService.get(contextOf(req, res.locals), uuidParam(req, 'id'));
      res.status(200).json(BudgetsPresenter.detail(budget));
    },

    async create(req, res, next) {
      try {
        const { created, budget } = await budgetsService.create(
          contextOf(req, res.locals),
          req.body as CreateBudgetInput,
        );
        res.status(created ? 201 : 200).json(BudgetsPresenter.one(budget));
      } catch (error) {
        if (error instanceof AppError && error.code === 'BUDGET_EXISTS') {
          sendBudgetExists(res, error);
          return;
        }
        next(error);
      }
    },

    async update(req, res) {
      const budget = await budgetsService.update(
        contextOf(req, res.locals),
        uuidParam(req, 'id'),
        req.body as UpdateBudgetInput,
      );
      res.status(200).json(BudgetsPresenter.one(budget));
    },

    async pause(req, res) {
      await budgetsService.pause(contextOf(req, res.locals), uuidParam(req, 'id'));
      res.status(204).end();
    },

    async resume(req, res) {
      await budgetsService.resume(contextOf(req, res.locals), uuidParam(req, 'id'));
      res.status(204).end();
    },

    async resetCarryover(req, res) {
      await budgetsService.resetCarryover(contextOf(req, res.locals), uuidParam(req, 'id'));
      res.status(204).end();
    },

    async remove(req, res) {
      await budgetsService.remove(contextOf(req, res.locals), uuidParam(req, 'id'));
      res.status(204).end();
    },

    async decide(req, res) {
      await budgetsService.decide(
        contextOf(req, res.locals),
        uuidParam(req, 'id'),
        uuidParam(req, 'periodId'),
        req.body as DecisionInput,
      );
      res.status(204).end();
    },
  };
}
