import type { RequestHandler } from 'express';

import type { Jobs } from '../../application/jobs/tick.js';
import type { Clock } from '../../application/ports/clock.js';

export interface CatchUpDeps {
  jobs: Pick<Jobs, 'catchUpUser'>;
  clock: Pick<Clock, 'todayFor'>;
}

/**
 * The first authenticated request of a user in their local day starts `catchUpUser` (ADR-01)
 * without waiting for it. The mark of "already ran today" lives in memory: the jobs are idempotent.
 */
export const catchUp = ({ jobs, clock }: CatchUpDeps): RequestHandler => {
  const doneDay = new Map<string, string>();
  return (req, _res, next) => {
    const auth = req.auth;
    if (auth !== undefined) {
      const today = clock.todayFor(auth.timezone);
      if (doneDay.get(auth.userId) !== today) {
        doneDay.set(auth.userId, today);
        try {
          jobs.catchUpUser(auth.userId).catch(() => undefined);
        } catch {
          // A failure of the catch-up never changes the response.
        }
      }
    }
    next();
  };
};
