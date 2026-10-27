import { DashboardQuery } from '@finanzas/contracts';
import type { Request, RequestHandler } from 'express';

import { AppError } from '../../application/errors.js';
import type { Clock } from '../../application/ports/clock.js';
import type { DashboardViewService } from '../../application/services/dashboard.service.js';
import type { SessionContext } from '../middlewares/require-session.js';
import { DashboardPresenter } from '../presenters/dashboard.presenter.js';

export interface DashboardControllerDeps {
  dashboardService: DashboardViewService;
  clock: Pick<Clock, 'now'>;
}

export interface DashboardController {
  get: RequestHandler;
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

const MONTH_NUMBER = /^\d{4}-(0[1-9]|1[0-2])$/;

/** Handlers of `/api/dashboard` (plan §4.8.2). The user always comes from the session. */
export function createDashboardController({
  dashboardService,
  clock,
}: DashboardControllerDeps): DashboardController {
  return {
    async get(req, res) {
      const parsed = DashboardQuery.safeParse(req.query);
      if (!parsed.success || !MONTH_NUMBER.test(parsed.data.month)) {
        throw new AppError('VALIDATION_ERROR', { issues: [{ path: 'month', code: 'invalid' }] });
      }
      const session = sessionOf(req);
      const view = await dashboardService.view(
        {
          userId: session.userId,
          timezone: session.timezone,
          now: clock.now(),
          traceId: traceIdOf(res.locals),
        },
        parsed.data.month,
      );
      res.status(200).json(DashboardPresenter.view(view));
    },
  };
}
