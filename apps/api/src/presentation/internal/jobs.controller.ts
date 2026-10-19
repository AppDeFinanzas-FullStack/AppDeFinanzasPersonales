import { createHash, timingSafeEqual } from 'node:crypto';

import { Router } from 'express';

import type { Jobs } from '../../application/jobs/tick.js';

export interface JobsControllerDeps {
  /** Value the scheduler sends in the `x-jobs-secret` header (ADR-01). */
  secret: string;
  jobs: Pick<Jobs, 'tick'>;
}

const digest = (value: string): Buffer => createHash('sha256').update(value).digest();

/** Constant-time comparison; the digests have the same length whatever the given value. */
const isJobsSecret = (given: string | undefined, secret: string): boolean =>
  given !== undefined && timingSafeEqual(digest(given), digest(secret));

/**
 * `POST /internal/jobs/tick` (plan §4.0, ADR-01). Without the right `x-jobs-secret` the request
 * goes on as if the route did not exist, so it gets the same 404 as any unknown route.
 */
export const jobsRouter = ({ secret, jobs }: JobsControllerDeps): Router => {
  const router = Router();
  router.post('/tick', async (req, res, next) => {
    if (!isJobsSecret(req.get('x-jobs-secret'), secret)) {
      next();
      return;
    }
    await jobs.tick();
    res.status(204).end();
  });
  return router;
};
