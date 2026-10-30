import type { RequestHandler } from 'express';

import type { Clock } from '../../application/ports/clock.js';

export interface TrackActivityDeps {
  sessions: { touch(sessionId: string, at: Date): Promise<void> };
  clock: Pick<Clock, 'now'>;
}

const RENEW_AFTER_MS = 5 * 60 * 1000;

/** Renews the activity of the session `requireSession` left in the request; it queries nothing. */
export const trackActivity =
  ({ sessions, clock }: TrackActivityDeps): RequestHandler =>
  (req, _res, next) => {
    const auth = req.auth;
    if (auth === undefined || req.get('X-Background') !== undefined) {
      next();
      return;
    }
    const now = clock.now();
    if (
      auth.lastActivityAt !== undefined &&
      now.getTime() - auth.lastActivityAt.getTime() < RENEW_AFTER_MS
    ) {
      next();
      return;
    }
    sessions.touch(auth.sessionId, now).then(() => {
      next();
    }, next);
  };
