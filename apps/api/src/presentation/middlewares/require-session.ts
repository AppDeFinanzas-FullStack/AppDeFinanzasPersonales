import type { RequestHandler } from 'express';

import type { AuthGateway } from '../../application/ports/auth-gateway.js';
import type { Clock } from '../../application/ports/clock.js';
import { sendProblem } from './error-handler.js';

export interface SessionContext {
  userId: string;
  sessionId: string;
  timezone: string;
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      auth?: SessionContext;
    }
  }
}

export interface SessionActivity {
  lastActivityAt: Date;
  timezone: string;
}

export interface SessionActivityReader {
  /** Returns the activity of the session, or null when it no longer exists. */
  findActivity(sessionId: string): Promise<SessionActivity | null>;
}

export interface RequireSessionDeps {
  auth: Pick<AuthGateway, 'getSession'>;
  sessions: SessionActivityReader;
  clock: Pick<Clock, 'now'>;
}

const COOKIE_NAME = '__Secure-better-auth.session_token';
const MAX_INACTIVITY_MS = 30 * 24 * 60 * 60 * 1000;

const safeDecode = (value: string): string | null => {
  try {
    return decodeURIComponent(value);
  } catch {
    return null;
  }
};

const tokenFromCookie = (header: string | undefined): string | null => {
  if (header === undefined) {
    return null;
  }
  for (const part of header.split(';')) {
    const separator = part.indexOf('=');
    if (separator === -1 || part.slice(0, separator).trim() !== COOKIE_NAME) {
      continue;
    }
    const decoded = safeDecode(part.slice(separator + 1).trim());
    const signed = decoded === null ? '' : decoded;
    const dot = signed.indexOf('.');
    const token = dot === -1 ? signed : signed.slice(0, dot);
    return token.length > 0 ? token : null;
  }
  return null;
};

export const requireSession =
  ({ auth, sessions, clock }: RequireSessionDeps): RequestHandler =>
  (req, res, next) => {
    const reject = (): void => {
      sendProblem(res, 401, 'SESSION_EXPIRED');
    };
    const token = tokenFromCookie(req.headers.cookie);
    if (token === null) {
      reject();
      return;
    }
    void (async () => {
      const session = await auth.getSession(token);
      if (session === null) {
        reject();
        return;
      }
      const activity = await sessions.findActivity(session.sessionId);
      if (
        activity === null ||
        activity.lastActivityAt.getTime() < clock.now().getTime() - MAX_INACTIVITY_MS
      ) {
        reject();
        return;
      }
      req.auth = {
        userId: session.userId,
        sessionId: session.sessionId,
        timezone: activity.timezone,
      };
      next();
    })().catch(next);
  };
