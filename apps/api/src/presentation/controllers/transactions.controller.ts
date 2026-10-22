import {
  DeleteTransactionInput,
  ListQuery,
  Uuid,
  type BatchDeleteInput,
  type BatchRecategorizeInput,
  type CreateTransactionInput,
  type UndoInput,
  type UpdateTransactionInput,
} from '@finanzas/contracts';
import type { Request, RequestHandler } from 'express';
import type { z } from 'zod';

import { AppError } from '../../application/errors.js';
import type { Clock } from '../../application/ports/clock.js';
import type { RatesContext } from '../../application/services/rates.service.js';
import type { RegisterService } from '../../application/services/register.service.js';
import type { TransactionsService } from '../../application/services/transactions.service.js';
import type { SessionContext } from '../middlewares/require-session.js';
import { TransactionsPresenter } from '../presenters/transactions.presenter.js';

export interface TransactionsControllerDeps {
  transactionsService: TransactionsService;
  /** The movements created today that a creation answers with (RF-M7-07, plan §4.7.2). */
  register: Pick<RegisterService, 'todayRecent'>;
  clock: Pick<Clock, 'now'>;
}

export interface TransactionsController {
  list: RequestHandler;
  summary: RequestHandler;
  get: RequestHandler;
  create: RequestHandler;
  update: RequestHandler;
  remove: RequestHandler;
  undo: RequestHandler;
  batchDelete: RequestHandler;
  batchRecategorize: RequestHandler;
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

/** An id that is not a UUID can not be one of the user's movements (RNF-14). */
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

/** The query string carries text, so `limit` becomes a number before `ListQuery` checks it. */
const listQueryOf = (req: Request): ListQuery => {
  const { limit, ...rest } = req.query;
  return parseQuery(ListQuery, limit === undefined ? rest : { ...rest, limit: Number(limit) });
};

/**
 * Handlers of `/api/transactions` (plan §4.6.2). The bodies were validated by the router; the user
 * always comes from the session, and another user's movement answers 404 (RN-09, RNF-14).
 */
export function createTransactionsController({
  transactionsService,
  register,
  clock,
}: TransactionsControllerDeps): TransactionsController {
  const contextOf = (req: Request, locals: Record<string, unknown>): RatesContext => {
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
      const query = listQueryOf(req);
      const page = await transactionsService.list(contextOf(req, res.locals), query);
      res.status(200).json(TransactionsPresenter.page(page));
    },

    async summary(req, res) {
      const query = listQueryOf(req);
      const totals = await transactionsService.summary(contextOf(req, res.locals), query);
      res.status(200).json(TransactionsPresenter.totals(totals));
    },

    async get(req, res) {
      const transaction = await transactionsService.get(contextOf(req, res.locals), idOf(req));
      res.status(200).json(TransactionsPresenter.transaction(transaction));
    },

    async create(req, res) {
      const ctx = contextOf(req, res.locals);
      const result = await transactionsService.create(ctx, req.body as CreateTransactionInput);
      // Registrar shows the last movements created today right after saving (RF-M7-07).
      const todayRecent = await register.todayRecent(ctx);
      // A retry with the same id and data answers the existing movement (ADR-11, RNF-11).
      res.status(result.created ? 201 : 200).json({
        ...TransactionsPresenter.created(result),
        todayRecent: todayRecent.map((movement) => TransactionsPresenter.transaction(movement)),
      });
    },

    async update(req, res) {
      const transaction = await transactionsService.update(
        contextOf(req, res.locals),
        idOf(req),
        req.body as UpdateTransactionInput,
      );
      res.status(200).json(TransactionsPresenter.transaction(transaction));
    },

    async remove(req, res) {
      // The body is optional: it only carries the earmark withdrawals the user confirmed.
      const options = parseQuery(DeleteTransactionInput, req.body ?? {});
      const result = await transactionsService.delete(
        contextOf(req, res.locals),
        idOf(req),
        options,
      );
      res.status(200).json(TransactionsPresenter.deleted(result));
    },

    async undo(req, res) {
      const { undoToken, earmarkWithdrawals } = req.body as UndoInput;
      await transactionsService.undo(contextOf(req, res.locals), undoToken, {
        earmarkWithdrawals,
      });
      res.status(204).end();
    },

    async batchDelete(req, res) {
      const result = await transactionsService.batchDelete(
        contextOf(req, res.locals),
        req.body as BatchDeleteInput,
      );
      res.status(200).json(TransactionsPresenter.batch(result));
    },

    async batchRecategorize(req, res) {
      const result = await transactionsService.batchRecategorize(
        contextOf(req, res.locals),
        req.body as BatchRecategorizeInput,
      );
      res.status(200).json(TransactionsPresenter.batch(result));
    },
  };
}
