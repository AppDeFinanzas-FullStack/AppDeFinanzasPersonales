import type { Request, RequestHandler } from 'express';

import { AppError } from '../../application/errors.js';
import type { Clock } from '../../application/ports/clock.js';
import type { RatesContext } from '../../application/services/rates.service.js';
import type { RegisterService } from '../../application/services/register.service.js';
import type { SessionContext } from '../middlewares/require-session.js';
import { RegisterPresenter } from '../presenters/register.presenter.js';

export interface RegisterControllerDeps {
  registerService: RegisterService;
  clock: Pick<Clock, 'now'>;
}

export interface RegisterController {
  context: RequestHandler;
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

/** Handlers of `/api/register` (plan §4.7.2); the user always comes from the session (RN-09). */
export function createRegisterController({
  registerService,
  clock,
}: RegisterControllerDeps): RegisterController {
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
    async context(req, res) {
      const context = await registerService.context(contextOf(req, res.locals));
      res.status(200).json(RegisterPresenter.context(context));
    },
  };
}
