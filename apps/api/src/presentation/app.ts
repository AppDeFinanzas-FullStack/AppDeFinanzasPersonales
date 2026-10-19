import { randomUUID } from 'node:crypto';

import express, { type Express, type RequestHandler } from 'express';

import { checkOrigin } from './middlewares/check-origin.js';
import { errorHandler } from './middlewares/error-handler.js';
import { requireJson } from './middlewares/require-json.js';
import { healthRouter } from './routes/health.routes.js';

export interface AppDeps {
  webOrigin: string;
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
  app.use('/api', healthRouter());
  app.use(errorHandler);
  return app;
};
