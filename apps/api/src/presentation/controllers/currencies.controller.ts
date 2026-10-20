import type { CreateCurrencyInput, UpdateCurrencyInput } from '@finanzas/contracts';
import { Decimal } from 'decimal.js';
import type { Request, RequestHandler } from 'express';

import { AppError } from '../../application/errors.js';
import type { Clock } from '../../application/ports/clock.js';
import type {
  CurrenciesContext,
  CurrenciesService,
} from '../../application/services/currencies.service.js';
import type { SessionContext } from '../middlewares/require-session.js';
import { CurrenciesPresenter } from '../presenters/currencies.presenter.js';

export interface CurrenciesControllerDeps {
  currenciesService: CurrenciesService;
  clock: Pick<Clock, 'now'>;
}

export interface CurrenciesController {
  list: RequestHandler;
  create: RequestHandler;
  update: RequestHandler;
}

const sessionOf = (req: Request): SessionContext => {
  if (req.auth === undefined) {
    throw new AppError('SESSION_EXPIRED');
  }
  return req.auth;
};

const codeOf = (req: Request): string => {
  const code: unknown = req.params['code'];
  return typeof code === 'string' ? code : '';
};

/**
 * Handlers of `/api/currencies` (plan §4.3.2). The bodies were validated by the router; the user
 * always comes from the session.
 */
export function createCurrenciesController({
  currenciesService,
  clock,
}: CurrenciesControllerDeps): CurrenciesController {
  const contextOf = (req: Request): CurrenciesContext => {
    const session = sessionOf(req);
    return { userId: session.userId, timezone: session.timezone, now: clock.now() };
  };

  return {
    async list(req, res) {
      const currencies = await currenciesService.list(contextOf(req));
      res.status(200).json(CurrenciesPresenter.list(currencies));
    },

    async create(req, res) {
      const body = req.body as CreateCurrencyInput;
      const currency = await currenciesService.create(contextOf(req), {
        code: body.code,
        symbol: body.symbol,
        rate: new Decimal(body.rate),
      });
      res.status(201).json(CurrenciesPresenter.toDto(currency));
    },

    async update(req, res) {
      const body = req.body as UpdateCurrencyInput;
      await currenciesService.update(contextOf(req), codeOf(req), {
        ...(body.symbol === undefined ? {} : { symbol: body.symbol }),
        ...(body.rate === undefined ? {} : { rate: new Decimal(body.rate) }),
      });
      res.status(204).end();
    },
  };
}
