import { randomUUID } from 'node:crypto';

import express, { type Express, type RequestHandler } from 'express';

import { jobsRouter, type JobsControllerDeps } from './internal/jobs.controller.js';
import { checkOrigin } from './middlewares/check-origin.js';
import { errorHandler } from './middlewares/error-handler.js';
import { requireJson } from './middlewares/require-json.js';
import { authRouter, type AuthRoutesDeps } from './routes/auth.routes.js';
import { healthRouter } from './routes/health.routes.js';
import { meRouter, type MeRoutesDeps } from './routes/me.routes.js';

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
  app.use('/api', healthRouter());
  if (deps.auth !== undefined) {
    app.use('/api/auth', authRouter(deps.auth));
  }
  if (deps.me !== undefined) {
    app.use('/api/me', meRouter(deps.me));
  }
  if (deps.jobs !== undefined) {
    app.use('/internal/jobs', jobsRouter(deps.jobs));
  }
  app.use(errorHandler);
  return app;
};
