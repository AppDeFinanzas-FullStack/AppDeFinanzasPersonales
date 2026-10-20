import type {
  ChangePwdInput,
  ConfirmInput,
  ForgotInput,
  ResendInput,
  ResetInput,
  SignInInput,
  SignUpInput,
} from '@finanzas/contracts';
import type { Request, RequestHandler, Response } from 'express';

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

const safeDecode = (value: string): string | null => {
  try {
    return decodeURIComponent(value);
  } catch {
    return null;
  }
};

/** The raw token of the session cookie (`<token>.<signature>`), or `null` without one. */
const sessionTokenOf = (req: Request): string | null => {
  const header = req.headers.cookie;
  if (header === undefined) {
    return null;
  }
  for (const part of header.split(';')) {
    const separator = part.indexOf('=');
    if (separator === -1 || part.slice(0, separator).trim() !== COOKIE_NAME) {
      continue;
    }
    const signed = safeDecode(part.slice(separator + 1).trim()) ?? '';
    const dot = signed.indexOf('.');
    const token = dot === -1 ? signed : signed.slice(0, dot);
    return token.length > 0 ? token : null;
  }
  return null;
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
      const result = await authService.signUp({
        name: body.name,
        email: body.email,
        password: body.password,
        termsAccepted: body.acceptTerms,
      });
      res.status(202).json(result);
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
      const current = sessionTokenOf(req);
      const open = current === null ? null : await sessions.getSession(current);
      const result = await authService.confirm(token, open?.sessionId);
      setSessionCookie(res, result.session);
      res.status(200).json({ next: result.next });
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
