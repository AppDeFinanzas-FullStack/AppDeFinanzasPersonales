import type {
  ChangePwdInput,
  ConfirmInput,
  ForgotInput,
  ResendInput,
  ResetInput,
  SignInInput,
  SignUpInput,
} from '@finanzas/contracts';
import type { CookieOptions, Request, RequestHandler, Response } from 'express';

import { AppError } from '../../application/errors.js';
import type { AuthGateway, CreatedSession } from '../../application/ports/auth-gateway.js';
import type { AuthService } from '../../application/services/auth.service.js';
import type { SessionContext } from '../middlewares/require-session.js';
import { MePresenter, type MeProfile, type Release } from '../presenters/me.presenter.js';

/** Reads the profile of the user behind a session, to answer with its `MeDto`. */
export interface MeReader {
  findBySession(sessionId: string): Promise<MeProfile | null>;
}

export interface AuthControllerDeps {
  authService: AuthService;
  /** Resolves the session cookie the device already carries, if any. */
  sessions: Pick<AuthGateway, 'getSession'>;
  me: MeReader;
  release: Release;
}

const COOKIE_NAME = '__Secure-better-auth.session_token';

/** Cookie of the registration ticket (RF-M1-18, plan §4.1.2). */
const TICKET_COOKIE_NAME = '__Secure-signup-ticket';
const TICKET_COOKIE_OPTIONS: CookieOptions = {
  httpOnly: true,
  secure: true,
  sameSite: 'lax',
  path: '/api/auth',
};
const TICKET_COOKIE_MAX_AGE_MS = 24 * 60 * 60 * 1000;

const safeDecode = (value: string): string | null => {
  try {
    return decodeURIComponent(value);
  } catch {
    return null;
  }
};

/** The decoded value of the cookie with that name, or `null` without one. */
const cookieOf = (req: Request, name: string): string | null => {
  const header = req.headers.cookie;
  if (header === undefined) {
    return null;
  }
  for (const part of header.split(';')) {
    const separator = part.indexOf('=');
    if (separator === -1 || part.slice(0, separator).trim() !== name) {
      continue;
    }
    const value = safeDecode(part.slice(separator + 1).trim()) ?? '';
    return value.length > 0 ? value : null;
  }
  return null;
};

/** The raw token of the session cookie (`<token>.<signature>`), or `null` without one. */
const sessionTokenOf = (req: Request): string | null => {
  const signed = cookieOf(req, COOKIE_NAME);
  if (signed === null) {
    return null;
  }
  const dot = signed.indexOf('.');
  const token = dot === -1 ? signed : signed.slice(0, dot);
  return token.length > 0 ? token : null;
};

/** The session `requireSession` left in the request. */
const sessionOf = (req: Request): SessionContext => {
  if (req.auth === undefined) {
    throw new AppError('SESSION_EXPIRED');
  }
  return req.auth;
};

const setSessionCookie = (res: Response, session: CreatedSession): void => {
  res.append('Set-Cookie', session.cookie);
};

export interface AuthController {
  signUp: RequestHandler;
  signIn: RequestHandler;
  resendConfirmation: RequestHandler;
  confirm: RequestHandler;
  confirmationStatus: RequestHandler;
  forgotPassword: RequestHandler;
  resetPassword: RequestHandler;
  changePassword: RequestHandler;
  signOut: RequestHandler;
  signOutAll: RequestHandler;
}

/** Handlers of `/api/auth/*` (plan §4.1.2). The bodies arrive already validated by `contracts`. */
export function createAuthController({
  authService,
  sessions,
  me,
  release,
}: AuthControllerDeps): AuthController {
  return {
    async signUp(req, res) {
      const body = req.body as SignUpInput;
      const { status, ticket } = await authService.signUp({
        name: body.name,
        email: body.email,
        password: body.password,
        termsAccepted: body.acceptTerms,
        timezone: body.timezone,
      });
      res.cookie(TICKET_COOKIE_NAME, ticket, {
        ...TICKET_COOKIE_OPTIONS,
        maxAge: TICKET_COOKIE_MAX_AGE_MS,
      });
      res.status(202).json({ status });
    },

    async signIn(req, res) {
      const body = req.body as SignInInput;
      const { session } = await authService.signIn({ email: body.email, password: body.password });
      const profile = await me.findBySession(session.sessionId);
      if (profile === null) {
        throw new AppError('SESSION_EXPIRED');
      }
      setSessionCookie(res, session);
      res.status(200).json({
        me: MePresenter.toDto(profile, release),
        next: profile.onboardingCompleted ? 'dashboard' : 'onboarding',
      });
    },

    async resendConfirmation(req, res) {
      await authService.resendConfirmation(req.body as ResendInput);
      res.status(202).end();
    },

    async confirm(req, res) {
      const { token } = req.body as ConfirmInput;
      const result = await authService.confirm(token);
      res.status(200).json(result);
    },

    async confirmationStatus(req, res) {
      const ticket = cookieOf(req, TICKET_COOKIE_NAME);
      if (ticket === null) {
        res.status(200).json({ status: 'pending' });
        return;
      }
      const current = sessionTokenOf(req);
      const open = current === null ? null : await sessions.getSession(current);
      const result = await authService.confirmationStatus(ticket, open?.sessionId);
      if (result.status === 'pending') {
        res.status(200).json({ status: 'pending' });
        return;
      }
      setSessionCookie(res, result.session);
      res.clearCookie(TICKET_COOKIE_NAME, TICKET_COOKIE_OPTIONS);
      res.status(200).json({ status: result.status, next: result.next });
    },

    async forgotPassword(req, res) {
      const { email } = req.body as ForgotInput;
      await authService.forgotPassword({ email });
      res.status(202).end();
    },

    async resetPassword(req, res) {
      const body = req.body as ResetInput;
      const result = await authService.resetPassword({
        token: body.token,
        newPassword: body.newPassword,
      });
      setSessionCookie(res, result.session);
      res.status(200).json({ next: result.next });
    },

    async changePassword(req, res) {
      const { userId, sessionId } = sessionOf(req);
      const body = req.body as ChangePwdInput;
      await authService.changePassword({
        userId,
        sessionId,
        currentPassword: body.currentPassword,
        newPassword: body.newPassword,
      });
      res.status(204).end();
    },

    async signOut(req, res) {
      await authService.signOut(sessionOf(req).sessionId);
      res.status(204).end();
    },

    async signOutAll(req, res) {
      await authService.signOutAll(sessionOf(req).userId);
      res.status(204).end();
    },
  };
}
