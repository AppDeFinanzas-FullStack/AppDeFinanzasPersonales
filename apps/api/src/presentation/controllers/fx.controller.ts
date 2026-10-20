import { RateHistoryQuery, type FxSettingsInput, type ManualUsdInput } from '@finanzas/contracts';
import { Decimal } from 'decimal.js';
import type { Request, RequestHandler } from 'express';

import { AppError } from '../../application/errors.js';
import type { Clock } from '../../application/ports/clock.js';
import type { MarketRateRow } from '../../application/ports/repositories.js';
import type {
  FxSettingsContext,
  FxSettingsService,
} from '../../application/services/fx-settings.service.js';
import type { RatesContext, RatesService } from '../../application/services/rates.service.js';
import type { SessionContext } from '../middlewares/require-session.js';
import { FxPresenter } from '../presenters/fx.presenter.js';

/** Daily rows of `market_rate` for a history range, in the user's calendar (RN-07). */
export interface RateHistoryReader {
  daily(query: RateHistoryQuery, timezone: string, now: Date): Promise<MarketRateRow[]>;
}

export interface FxControllerDeps {
  ratesService: Pick<RatesService, 'current'>;
  rateHistory: RateHistoryReader;
  /** Starts `fx.fetchParallel` in the background; it never waits for the source (RNF-04). */
  refreshParallel: () => void;
  clock: Pick<Clock, 'now'>;
}

export interface FxController {
  current: RequestHandler;
  history: RequestHandler;
}

/** A parallel capture older than this is refreshed when the rates are read (RF-M3-04). */
const STALE_AFTER_MS = 60_000;

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

const isStale = (observedAt: string | undefined, now: Date): boolean =>
  observedAt === undefined || now.getTime() - new Date(observedAt).getTime() > STALE_AFTER_MS;

/** Handlers of `/api/rates` (plan §4.3.2). The user always comes from the session. */
export function createFxController({
  ratesService,
  rateHistory,
  refreshParallel,
  clock,
}: FxControllerDeps): FxController {
  return {
    async current(req, res) {
      const session = sessionOf(req);
      const ctx: RatesContext = {
        userId: session.userId,
        timezone: session.timezone,
        now: clock.now(),
        traceId: traceIdOf(res.locals),
      };
      const rates = await ratesService.current(ctx);
      if (isStale(rates.references.parallel_median?.observedAt, ctx.now)) {
        refreshParallel();
      }
      res.status(200).json(FxPresenter.current(rates));
    },

    async history(req, res) {
      const session = sessionOf(req);
      const parsed = RateHistoryQuery.safeParse(req.query);
      if (!parsed.success) {
        const issues = parsed.error.issues.map((issue) => ({
          path: issue.path.map(String).join('.'),
          code: issue.code,
        }));
        throw new AppError('VALIDATION_ERROR', { issues });
      }
      const rows = await rateHistory.daily(parsed.data, session.timezone, clock.now());
      res.status(200).json(FxPresenter.history(rows));
    },
  };
}

export interface FxSettingsControllerDeps {
  fxSettingsService: FxSettingsService;
  clock: Pick<Clock, 'now'>;
}

export interface FxSettingsController {
  updateSettings: RequestHandler;
  setManual: RequestHandler;
  clearManual: RequestHandler;
}

/**
 * Handlers of `/api/fx-settings` and `/api/fx/manual` (plan §4.3.2). The bodies were validated by
 * the router; the user always comes from the session.
 */
export function createFxSettingsController({
  fxSettingsService,
  clock,
}: FxSettingsControllerDeps): FxSettingsController {
  const contextOf = (req: Request): FxSettingsContext => ({
    userId: sessionOf(req).userId,
    now: clock.now(),
  });

  return {
    async updateSettings(req, res) {
      const body = req.body as FxSettingsInput;
      await fxSettingsService.update(contextOf(req), {
        ...(body.usdReference === undefined ? {} : { usdReference: body.usdReference }),
        ...(body.baseCurrency === undefined ? {} : { baseCurrency: body.baseCurrency }),
      });
      res.status(204).end();
    },

    async setManual(req, res) {
      const body = req.body as ManualUsdInput;
      await fxSettingsService.setManual(contextOf(req), new Decimal(body.value));
      res.status(204).end();
    },

    async clearManual(req, res) {
      await fxSettingsService.clearManual(contextOf(req));
      res.status(204).end();
    },
  };
}
