import { Router } from 'express';

import type { ReadinessProbe } from '../../application/ports/readiness.js';

/**
 * `GET /api/health` says the API is alive without touching the database; `GET /api/health/ready`
 * also checks the database and answers 204 or 503, never with a body (plan §4.2.2).
 */
export const healthRouter = (readiness?: ReadinessProbe): Router => {
  const router = Router();
  router.get('/health', (_req, res) => {
    res.status(204).end();
  });
  if (readiness !== undefined) {
    router.get('/health/ready', async (_req, res) => {
      const ready = await readiness.check();
      res.status(ready ? 204 : 503).end();
    });
  }
  return router;
};
