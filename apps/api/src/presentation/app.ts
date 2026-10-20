import { randomUUID } from 'node:crypto';

import express, { type Express, type RequestHandler } from 'express';

import type { ReadinessProbe } from '../application/ports/readiness.js';

import { jobsRouter, type JobsControllerDeps } from './internal/jobs.controller.js';
import {
  testSupportRouter,
  type TestSupportControllerDeps,
} from './internal/test-support.controller.js';
import { checkOrigin } from './middlewares/check-origin.js';
import { errorHandler } from './middlewares/error-handler.js';
import { requireJson } from './middlewares/require-json.js';
import { accountsRouter, type AccountsRoutesDeps } from './routes/accounts.routes.js';
import { authRouter, type AuthRoutesDeps } from './routes/auth.routes.js';
import { categoriesRouter, type CategoriesRoutesDeps } from './routes/categories.routes.js';
import { currenciesRouter, type CurrenciesRoutesDeps } from './routes/currencies.routes.js';
import {
  fxRouter,
  ratesRouter,
  type FxRoutesDeps,
  type RatesRoutesDeps,
} from './routes/fx.routes.js';
import { healthRouter } from './routes/health.routes.js';
import { meRouter, type MeRoutesDeps } from './routes/me.routes.js';
import { settingsRouter, type SettingsRoutesDeps } from './routes/settings.routes.js';
import { shortcutsRouter, type ShortcutsRoutesDeps } from './routes/shortcuts.routes.js';
import { transactionsRouter, type TransactionsRoutesDeps } from './routes/transactions.routes.js';

export interface AppDeps {
  webOrigin: string;
  /** The internal tick endpoint (ADR-01); an app built without it does not expose it. */
  jobs?: JobsControllerDeps;
  /** Per-user catch-up (ADR-01); it runs after the session is resolved. */
  catchUp?: RequestHandler;
  /** The routes `/api/auth/*` (plan §4.1.2); an app built without them does not expose them. */
  auth?: AuthRoutesDeps;
  /** The routes `/api/me` (plan §4.1.2). */
  me?: MeRoutesDeps;
  /** The routes `/api/settings` (plan §4.9.2). */
  settings?: SettingsRoutesDeps;
  /** The routes `/api/rates` (plan §4.3.2). */
  rates?: RatesRoutesDeps;
  /** The routes `/api/fx-settings` and `/api/fx/manual` (plan §4.3.2). */
  fx?: FxRoutesDeps;
  /** The routes `/api/currencies` (plan §4.3.2). */
  currencies?: CurrenciesRoutesDeps;
  /** The routes `/api/accounts` (plan §4.4.2). */
  accounts?: AccountsRoutesDeps;
  /** The routes `/api/shortcuts` (plan §4.7.2). */
  shortcuts?: ShortcutsRoutesDeps;
  /** The routes `/api/categories` (plan §4.5.2). */
  categories?: CategoriesRoutesDeps;
  /** The routes `/api/transactions` (plan §4.6.2). */
  transactions?: TransactionsRoutesDeps;

  /** The test-support routes (plan §1.5); only an app with fake integrations gets them. */
  testSupport?: TestSupportControllerDeps;
  /** The database check of `GET /api/health/ready` (plan §4.2.2); without it the route is absent. */
  readiness?: ReadinessProbe;
}

const traceId: RequestHandler = (_req, res, next) => {
  res.locals['traceId'] = randomUUID();
  next();
};

const requestLog: RequestHandler = (req, res, next) => {
  const start = process.hrtime.bigint();
  res.on('finish', () => {
    const durationMs = Number(process.hrtime.bigint() - start) / 1e6;
    console.info(
      JSON.stringify({
        traceId: res.locals['traceId'] as unknown,
        method: req.method,
        path: req.originalUrl.split('?')[0],
        status: res.statusCode,
        durationMs: Math.round(durationMs * 100) / 100,
      }),
    );
  });
  next();
};

export const createApp = (deps: AppDeps): Express => {
  const app = express();
  app.disable('x-powered-by');
  app.use(traceId);
  app.use(requestLog);
  app.use(checkOrigin(deps.webOrigin));
  app.use(requireJson);
  app.use(express.json());
  if (deps.catchUp !== undefined) {
    app.use(deps.catchUp);
  }
  app.use('/api', healthRouter(deps.readiness));
  if (deps.auth !== undefined) {
    app.use('/api/auth', authRouter(deps.auth));
  }
  if (deps.me !== undefined) {
    app.use('/api/me', meRouter(deps.me));
  }
  if (deps.settings !== undefined) {
    app.use('/api/settings', settingsRouter(deps.settings));
  }
  if (deps.rates !== undefined) {
    app.use('/api/rates', ratesRouter(deps.rates));
  }
  if (deps.fx !== undefined) {
    app.use('/api', fxRouter(deps.fx));
  }
  if (deps.currencies !== undefined) {
    app.use('/api/currencies', currenciesRouter(deps.currencies));
  }
  if (deps.accounts !== undefined) {
    app.use('/api/accounts', accountsRouter(deps.accounts));
  }
  if (deps.shortcuts !== undefined) {
    app.use('/api/shortcuts', shortcutsRouter(deps.shortcuts));
  }
  if (deps.categories !== undefined) {
    app.use('/api/categories', categoriesRouter(deps.categories));
  }
  if (deps.transactions !== undefined) {
    app.use('/api/transactions', transactionsRouter(deps.transactions));
  }
  if (deps.jobs !== undefined) {
    app.use('/internal/jobs', jobsRouter(deps.jobs));
  }
  if (deps.testSupport !== undefined) {
    app.use('/internal/test', testSupportRouter(deps.testSupport));
  }
  app.use(errorHandler);
  return app;
};
