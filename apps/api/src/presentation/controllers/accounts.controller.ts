import {
  LocalDate,
  Uuid,
  type AdjustInput,
  type ArchiveInput,
  type CreateAccountInput,
  type ReorderInput,
  type RestoreInput,
  type UpdateAccountInput,
} from '@finanzas/contracts';
import type { Request, RequestHandler } from 'express';
import { z } from 'zod';

import { AppError } from '../../application/errors.js';
import type { Clock } from '../../application/ports/clock.js';
import type { BalancePoint } from '../../application/ports/repositories.js';
import type {
  AccountsContext,
  AccountsService,
} from '../../application/services/accounts.service.js';
import type { SessionContext } from '../middlewares/require-session.js';
import { AccountsPresenter } from '../presenters/accounts.presenter.js';

/** Balance of one of the user's accounts at the end of each day of a range (RN-01). */
export interface BalanceSeriesReader {
  /** `null` when the user has no such account (RN-09). */
  daily(
    userId: string,
    accountId: string,
    from: string,
    to: string,
  ): Promise<BalancePoint[] | null>;
}

export interface AccountsControllerDeps {
  accountsService: AccountsService;
  balanceSeries: BalanceSeriesReader;
  clock: Pick<Clock, 'now'>;
}

export interface AccountsController {
  list: RequestHandler;
  create: RequestHandler;
  update: RequestHandler;
  reorder: RequestHandler;
  adjust: RequestHandler;
  archive: RequestHandler;
  restore: RequestHandler;
  remove: RequestHandler;
  balanceSeries: RequestHandler;
}

const ListQuery = z.object({ status: z.enum(['active', 'archived']).default('active') });

const BalanceSeriesQuery = z
  .object({ from: LocalDate, to: LocalDate })
  .refine((query) => query.from <= query.to, { path: ['to'] });

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

/** An id that is not a UUID can not be one of the user's accounts (RNF-14). */
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
 * Handlers of `/api/accounts` (plan §4.4.2). The bodies were validated by the router; the user
 * always comes from the session, and another user's account answers 404 (RN-09, RNF-14).
 */
export function createAccountsController({
  accountsService,
  balanceSeries,
  clock,
}: AccountsControllerDeps): AccountsController {
  const contextOf = (req: Request, locals: Record<string, unknown>): AccountsContext => {
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
      const { status } = parseQuery(ListQuery, req.query);
      const ctx = contextOf(req, res.locals);
      const items = await accountsService.list(ctx, status);
      const summary = await accountsService.summary(ctx);
      res.status(200).json(AccountsPresenter.list(items, summary));
    },

    async create(req, res) {
      const { created, account } = await accountsService.create(
        contextOf(req, res.locals),
        req.body as CreateAccountInput,
      );
      res.status(created ? 201 : 200).json(account);
    },

    async update(req, res) {
      const account = await accountsService.update(
        contextOf(req, res.locals),
        idOf(req),
        req.body as UpdateAccountInput,
      );
      res.status(200).json(account);
    },

    async reorder(req, res) {
      await accountsService.reorder(contextOf(req, res.locals), req.body as ReorderInput);
      res.status(204).end();
    },

    async adjust(req, res) {
      const { created, transaction } = await accountsService.adjust(
        contextOf(req, res.locals),
        idOf(req),
        req.body as AdjustInput,
      );
      if (transaction === null) {
        // EC-M4-08: the balance already matches.
        res.status(200).json({ created: false });
        return;
      }
      res.status(created ? 201 : 200).json({ created, transactionId: transaction.id });
    },

    async archive(req, res) {
      const account = await accountsService.archive(
        contextOf(req, res.locals),
        idOf(req),
        req.body as ArchiveInput,
      );
      res.status(200).json(account);
    },

    async restore(req, res) {
      const account = await accountsService.restore(
        contextOf(req, res.locals),
        idOf(req),
        req.body as RestoreInput,
      );
      res.status(200).json(account);
    },

    async remove(req, res) {
      await accountsService.remove(contextOf(req, res.locals), idOf(req));
      res.status(204).end();
    },

    async balanceSeries(req, res) {
      const id = idOf(req);
      const { from, to } = parseQuery(BalanceSeriesQuery, req.query);
      const points = await balanceSeries.daily(sessionOf(req).userId, id, from, to);
      if (points === null) {
        throw new AppError('NOT_FOUND');
      }
      res.status(200).json(AccountsPresenter.balanceSeries(points));
    },
  };
}
