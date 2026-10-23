import {
  DeleteDebtInput,
  EarmarkWithdrawals,
  Uuid,
  type CreateDebtInput,
  type PaymentInput,
  type UpdateDebtInput,
} from '@finanzas/contracts';
import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { z } from 'zod';

import { AppError } from '../../application/errors.js';
import type { Clock } from '../../application/ports/clock.js';
import type { DebtsContext, DebtsService } from '../../application/services/debts.service.js';
import type { SessionContext } from '../middlewares/require-session.js';
import { DebtsPresenter } from '../presenters/debts.presenter.js';

export interface DebtsControllerDeps {
  debtsService: DebtsService;
  clock: Pick<Clock, 'now'>;
}

export interface DebtsController {
  list: RequestHandler;
  create: RequestHandler;
  update: RequestHandler;
  pay: RequestHandler;
  deleteLastPayment: RequestHandler;
  forgive: RequestHandler;
  remove: RequestHandler;
}

const ListQuery = z.object({ view: z.enum(['debt', 'person']).default('debt') });

const DeleteLastPaymentInput = z.object({ earmarkWithdrawals: EarmarkWithdrawals.optional() });

/** Problems whose data also travels at the top of the body (EC-M13-01, plan §4.13.2). */
const TOP_LEVEL_DATA: ReadonlySet<string> = new Set([
  'PAYMENT_EXCEEDS_BALANCE',
  'SPLIT_INVALID',
  'MOVEMENTS_CHOICE_REQUIRED',
]);

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

/** An id that is not a UUID can not be one of the user's debts (RNF-14). */
const idOf = (req: Request): string => {
  const parsed = Uuid.safeParse(req.params['id']);
  if (!parsed.success) {
    throw new AppError('NOT_FOUND');
  }
  return parsed.data;
};

function parseInput<T>(schema: z.ZodType<T>, input: unknown): T {
  const parsed = schema.safeParse(input);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((issue) => ({
      path: issue.path.map(String).join('.'),
      code: issue.code,
    }));
    throw new AppError('VALIDATION_ERROR', { issues });
  }
  return parsed.data;
}

/** Sends the problem with its data at the top as well as in `data`, or passes the error on. */
const answerProblem = (error: unknown, res: Response, next: NextFunction): void => {
  if (error instanceof AppError && TOP_LEVEL_DATA.has(error.code)) {
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
    return;
  }
  next(error);
};

/**
 * Handlers of `/api/debts` (plan §4.13.2). The bodies were validated by the router; the user
 * always comes from the session, and another user's debt answers 404 (RNF-14).
 */
export function createDebtsController({
  debtsService,
  clock,
}: DebtsControllerDeps): DebtsController {
  const contextOf = (req: Request, locals: Record<string, unknown>): DebtsContext => {
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
      const { view } = parseInput(ListQuery, req.query);
      const result = await debtsService.list(contextOf(req, res.locals), view);
      res.status(200).json(DebtsPresenter.list(result));
    },

    async create(req, res) {
      const { created, debt } = await debtsService.create(
        contextOf(req, res.locals),
        req.body as CreateDebtInput,
      );
      res.status(created ? 201 : 200).json(DebtsPresenter.one(debt));
    },

    async update(req, res) {
      const debt = await debtsService.update(
        contextOf(req, res.locals),
        idOf(req),
        req.body as UpdateDebtInput,
      );
      res.status(200).json(DebtsPresenter.one(debt));
    },

    async pay(req, res, next) {
      try {
        const { created, debt } = await debtsService.pay(
          contextOf(req, res.locals),
          idOf(req),
          req.body as PaymentInput,
        );
        res.status(created ? 201 : 200).json(DebtsPresenter.one(debt));
      } catch (error) {
        answerProblem(error, res, next);
      }
    },

    async deleteLastPayment(req, res) {
      const { earmarkWithdrawals } = parseInput(DeleteLastPaymentInput, req.body ?? {});
      const debt = await debtsService.deleteLastPayment(
        contextOf(req, res.locals),
        idOf(req),
        earmarkWithdrawals,
      );
      res.status(200).json(DebtsPresenter.one(debt));
    },

    async forgive(req, res) {
      const debt = await debtsService.forgive(contextOf(req, res.locals), idOf(req));
      res.status(200).json(DebtsPresenter.one(debt));
    },

    async remove(req, res, next) {
      try {
        const movements = req.query['movements'];
        const input = parseInput(
          DeleteDebtInput,
          movements === undefined ? (req.body ?? {}) : { movements },
        );
        await debtsService.remove(contextOf(req, res.locals), idOf(req), input);
        res.status(204).end();
      } catch (error) {
        answerProblem(error, res, next);
      }
    },
  };
}
