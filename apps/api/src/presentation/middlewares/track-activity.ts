import type { RequestHandler } from 'express';

import type { Clock } from '../../application/ports/clock.js';
import type { SessionActivityReader } from './require-session.js';

export interface TrackActivityDeps {
  sessions: SessionActivityReader & { touch(sessionId: string, at: Date): Promise<void> };
  clock: Pick<Clock, 'now'>;
}

const RENEW_AFTER_MS = 5 * 60 * 1000;

export const trackActivity =
  ({ sessions, clock }: TrackActivityDeps): RequestHandler =>
  (req, _res, next) => {
    const sessionId = req.auth?.sessionId;
    if (sessionId === undefined || req.get('X-Background') !== undefined) {
      next();
      return;
    }
    void (async () => {
      const activity = await sessions.findActivity(sessionId);
      const now = clock.now();
      if (activity !== null && now.getTime() - activity.lastActivityAt.getTime() >= RENEW_AFTER_MS) {
        await sessions.touch(sessionId, now);
      }
      next();
    })().catch(next);
  };
