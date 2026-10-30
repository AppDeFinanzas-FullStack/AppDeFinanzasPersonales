import type { RequestHandler } from 'express';

import type { Clock } from '../../application/ports/clock.js';
import { sendProblem } from './error-handler.js';

export interface SessionContext {
  userId: string;
  sessionId: string;
  timezone: string;
  /** Always set by `requireSession`; other suites that stub `req.auth` may leave it out. */
  lastActivityAt?: Date;
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      auth?: SessionContext;
    }
  }
}

export interface SessionRecord {
  sessionId: string;
  userId: string;
  expiresAt: Date;
  lastActivityAt: Date;
  timezone: string;
}

export interface SessionActivityReader {
  /**
   * Resolves a session by its token with a single statement (session joined with its user), or
   * null when no session has that token any more.
   */
  findByToken(token: string): Promise<SessionRecord | null>;
}

export interface RequireSessionDeps {
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
  ({ sessions, clock }: RequireSessionDeps): RequestHandler =>
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
      const session = await sessions.findByToken(token);
      const now = clock.now().getTime();
      if (
        session === null ||
        session.expiresAt.getTime() <= now ||
        session.lastActivityAt.getTime() < now - MAX_INACTIVITY_MS
      ) {
        reject();
        return;
      }
      req.auth = {
        userId: session.userId,
        sessionId: session.sessionId,
        timezone: session.timezone,
        lastActivityAt: session.lastActivityAt,
      };
      next();
    })().catch(next);
  };
