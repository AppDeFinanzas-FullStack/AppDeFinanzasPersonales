import { createHmac } from 'node:crypto';

import { uuidv7 } from 'uuidv7';

import { AppError } from '../errors.js';
import type { AuthGateway, CreatedSession } from '../ports/auth-gateway.js';
import type { Repositories } from '../ports/repositories.js';
import type { UnitOfWork } from '../ports/unit-of-work.js';
import { bootstrapUser } from '../shared/user-bootstrap.js';

export interface SignUpInput {
  name: string;
  email: string;
  password: string;
  termsAccepted: boolean;
}

export interface SignUpResult {
  status: 'check_email';
}

/** The account to send the confirmation to again: by its email or by the token of a link. */
export type ResendConfirmationInput = { email: string } | { token: string };

export interface ConfirmResult {
  next: 'onboarding';
  session: CreatedSession;
}

export interface SignInInput {
  email: string;
  password: string;
}

export interface SignInResult {
  session: CreatedSession;
}

export interface ForgotPasswordInput {
  email: string;
}

export interface ResetPasswordInput {
  token: string;
  newPassword: string;
}

export interface ResetPasswordResult {
  next: 'onboarding' | 'dashboard';
  session: CreatedSession;
}

/** `userId` and `sessionId` come from the session of the request, never from its body. */
export interface ChangePasswordInput {
  userId: string;
  sessionId: string;
  currentPassword: string;
  newPassword: string;
}

export interface AuthService {
  /** Always answers the neutral `check_email`, whatever the state of the email (RF-M1-03). */
  signUp(input: SignUpInput): Promise<SignUpResult>;
  /**
   * Opens a session with the email and the password. Rejects with `LOGIN_LOCKED` while a wait is
   * running (EC-M1-04), `INVALID_CREDENTIALS` whatever the wrong data (RNF-15), or
   * `EMAIL_NOT_CONFIRMED` without opening a session (RF-M1-04). Counts failures (RF-M1-08).
   */
  signIn(input: SignInInput): Promise<SignInResult>;
  /** Closes that session. */
  signOut(sessionId: string): Promise<void>;
  /** Closes every session of the user (RF-M1-07). */
  signOutAll(userId: string): Promise<void>;
  /**
   * Sends a new confirmation link within the limits of 60 s and 5 per hour (RF-M1-05). Always
   * resolves, whether it sent anything or not.
   */
  resendConfirmation(input: ResendConfirmationInput): Promise<void>;
  /**
   * Consumes the confirmation link, marks the email as verified and opens a session, closing the
   * session that was open on the device (EC-M1-11). Rejects with `LINK_INVALID` or
   * `LINK_ALREADY_USED` (EC-M1-01, EC-M1-02).
   */
  confirm(token: string, currentSessionId?: string): Promise<ConfirmResult>;
  /**
   * Issues a recovery link of 1 hour, invalidating the previous one, and leaves the `reset` email
   * in the outbox (RF-M1-09). Always resolves, whether the email has an account or not.
   */
  forgotPassword(input: ForgotPasswordInput): Promise<void>;
  /**
   * Consumes the recovery link, sets the new password, confirms the email if it was not
   * (EC-M1-10), closes every session, opens a new one and sends `password_changed` (RF-M1-10).
   * Rejects with `LINK_INVALID`.
   */
  resetPassword(input: ResetPasswordInput): Promise<ResetPasswordResult>;
  /**
   * Checks the current password, sets the new one, closes every other session and sends
   * `password_changed` (RF-M1-10, EC-M1-05). Rejects with `INVALID_CURRENT_PASSWORD`.
   */
  changePassword(input: ChangePasswordInput): Promise<void>;
}

export interface AuthServiceDeps {
  uow: UnitOfWork;
  auth: AuthGateway;
  hmacSecret: string;
  webOrigin: string;
}

/** Every sign-up takes at least this long, so the time does not tell the three cases apart. */
const MIN_SIGN_UP_MILLISECONDS = 300;

/** Resend limits of the confirmation (RF-M1-05). */
const RESEND_MIN_INTERVAL_SECONDS = 60;
const RESEND_WINDOW_SECONDS = 60 * 60;
const RESEND_MAX_PER_WINDOW = 5;

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export function createAuthService({
  uow,
  auth,
  hmacSecret,
  webOrigin,
}: AuthServiceDeps): AuthService {
  const hmacOf = (email: string) => createHmac('sha256', hmacSecret).update(email).digest('hex');

  /** Hash checked when the email has no account, so the time does not reveal it (RNF-15). */
  let dummyHash: Promise<string> | undefined;
  const dummyHashOnce = () => (dummyHash ??= auth.hashPassword(uuidv7()));

  /** Counts a failed sign-in and warns the owner, at most once per hour (RF-M1-08, RNF-25). */
  async function recordSignInFailure(
    repos: Repositories,
    email: string,
    emailHmac: string,
    hasAccount: boolean,
  ): Promise<void> {
    await repos.loginThrottle.recordFailure(emailHmac);
    if (hasAccount && (await repos.loginThrottle.claimAlert(emailHmac))) {
      await repos.emailOutbox.enqueue({ id: uuidv7(), to: email, kind: 'login_alert', payload: {} });
    }
  }

  /** Issues a new confirmation link and leaves the `confirm` email in the outbox. */
  async function sendConfirmation(repos: Repositories, userId: string, email: string) {
    const { token } = await repos.emailLinks.create(userId, 'confirm_email');
    await repos.emailOutbox.enqueue({
      id: uuidv7(),
      to: email,
      kind: 'confirm',
      payload: { link: `${webOrigin}/confirmar?token=${token}` },
    });
  }

  async function register(
    repos: Repositories,
    name: string,
    email: string,
    passwordHash: string,
  ): Promise<void> {
    let existing = await repos.users.findByEmail(email);
    if (existing === null) {
      const id = uuidv7();
      if (await repos.users.createUnconfirmed({ id, name, email, passwordHash })) {
        await bootstrapUser(repos, id);
        await sendConfirmation(repos, id, email);
        return;
      }
      // Lost the race on the unique email: go on through the existing user.
      existing = await repos.users.findByEmail(email);
    }
    if (existing === null) {
      return;
    }
    if (existing.emailVerified) {
      if (await repos.users.claimRegisterAttempt(hmacOf(email))) {
        await repos.emailOutbox.enqueue({
          id: uuidv7(),
          to: email,
          kind: 'register_attempt',
          payload: {},
        });
      }
      return;
    }
    const userId = await repos.users.replaceUnconfirmed(email, name, passwordHash);
    if (userId !== null) {
      await sendConfirmation(repos, userId, email);
    }
  }

  /** The unconfirmed account the resend is for, locked until the transaction ends, or `null`. */
  async function resendTarget(repos: Repositories, input: ResendConfirmationInput) {
    if ('email' in input) {
      const email = input.email.trim().toLowerCase();
      const user = await repos.users.findByEmail(email);
      return user === null ? null : { userId: user.id, email, emailVerified: user.emailVerified };
    }
    return repos.emailLinks.findOwner(input.token, 'confirm_email');
  }

  async function resend(repos: Repositories, input: ResendConfirmationInput): Promise<void> {
    const target = await resendTarget(repos, input);
    if (target === null || target.emailVerified) {
      return;
    }
    const emailHmac = hmacOf(target.email);
    const sendLog = repos.emailSendLog;
    if ((await sendLog.countSince(emailHmac, 'confirm', RESEND_MIN_INTERVAL_SECONDS)) > 0) {
      return;
    }
    if (
      (await sendLog.countSince(emailHmac, 'confirm', RESEND_WINDOW_SECONDS)) >=
      RESEND_MAX_PER_WINDOW
    ) {
      return;
    }
    await sendConfirmation(repos, target.userId, target.email);
    await sendLog.record(emailHmac, 'confirm');
  }

  /** Consumes the link and returns its user, or throws the error of the link (EC-M1-01, EC-M1-02). */
  async function consumeConfirmation(repos: Repositories, token: string): Promise<string> {
    const result = await repos.emailLinks.consume(token, 'confirm_email');
    if (result.ok) {
      return result.userId;
    }
    const owner = await repos.emailLinks.findOwner(token, 'confirm_email');
    if (result.reason === 'LINK_ALREADY_USED' && owner?.emailVerified === true) {
      throw new AppError('LINK_ALREADY_USED');
    }
    throw new AppError('LINK_INVALID', { canResend: owner !== null && !owner.emailVerified });
  }

  /** Issues a recovery link for the account of that email, if there is one (RF-M1-09). */
  async function sendRecovery(repos: Repositories, email: string): Promise<void> {
    const user = await repos.users.findByEmail(email);
    if (user === null) {
      return;
    }
    const { token } = await repos.emailLinks.create(user.id, 'reset_password');
    await repos.emailOutbox.enqueue({
      id: uuidv7(),
      to: email,
      kind: 'reset',
      payload: { link: `${webOrigin}/restablecer?token=${token}` },
    });
  }

  /**
   * Consumes the recovery link, sets the new password hash, confirms the email (EC-M1-10) and
   * leaves `password_changed` in the outbox. Returns the user, or throws `LINK_INVALID`.
   */
  async function applyRecovery(
    repos: Repositories,
    token: string,
    passwordHash: string,
  ): Promise<{ userId: string; onboardingCompleted: boolean }> {
    const result = await repos.emailLinks.consume(token, 'reset_password');
    if (!result.ok) {
      throw new AppError('LINK_INVALID');
    }
    const account = await repos.users.findAccount(result.userId);
    if (account === null) {
      throw new AppError('LINK_INVALID');
    }
    await repos.users.setPassword(account.id, passwordHash);
    await repos.users.markEmailVerified(account.id);
    await repos.emailOutbox.enqueue({
      id: uuidv7(),
      to: account.email,
      kind: 'password_changed',
      payload: {},
    });
    return { userId: account.id, onboardingCompleted: account.onboardingCompleted };
  }

  return {
    async signUp(input) {
      const started = performance.now();
      const email = input.email.trim().toLowerCase();
      const name = input.name.trim();
      const passwordHash = await auth.hashPassword(input.password);

      await uow.run((repos) => register(repos, name, email, passwordHash));

      const remaining = MIN_SIGN_UP_MILLISECONDS - (performance.now() - started);
      if (remaining > 0) {
        await sleep(remaining);
      }
      return { status: 'check_email' };
    },

    async signIn(input) {
      const email = input.email.trim().toLowerCase();
      const emailHmac = hmacOf(email);

      const { remaining, credential } = await uow.run(
        async (repos) => ({
          remaining: await repos.loginThrottle.remainingSeconds(emailHmac),
          credential: await repos.users.findCredential(email),
        }),
        { readOnly: true },
      );
      if (remaining > 0) {
        throw new AppError('LOGIN_LOCKED', { retryAfterSeconds: remaining });
      }

      const hash = credential?.passwordHash ?? (await dummyHashOnce());
      const valid = await auth.verifyPassword(hash, input.password);
      if (!valid || credential === null) {
        await uow.run((repos) =>
          recordSignInFailure(repos, email, emailHmac, credential !== null),
        );
        throw new AppError('INVALID_CREDENTIALS');
      }

      await uow.run((repos) => repos.loginThrottle.reset(emailHmac));
      if (!credential.emailVerified) {
        throw new AppError('EMAIL_NOT_CONFIRMED');
      }
      const session = await auth.createSession(credential.id);
      return { session };
    },

    async signOut(sessionId) {
      await auth.deleteSession(sessionId);
    },

    async signOutAll(userId) {
      await auth.revokeSessions(userId);
    },

    async resendConfirmation(input) {
      await uow.run((repos) => resend(repos, input));
    },

    async confirm(token, currentSessionId) {
      const userId = await uow.run((repos) => consumeConfirmation(repos, token));
      await auth.markEmailVerified(userId);
      if (currentSessionId !== undefined) {
        await auth.deleteSession(currentSessionId);
      }
      const session = await auth.createSession(userId);
      return { next: 'onboarding', session };
    },

    async forgotPassword(input) {
      const email = input.email.trim().toLowerCase();
      await uow.run((repos) => sendRecovery(repos, email));
    },

    async resetPassword(input) {
      const passwordHash = await auth.hashPassword(input.newPassword);
      const { userId, onboardingCompleted } = await uow.run((repos) =>
        applyRecovery(repos, input.token, passwordHash),
      );
      await auth.revokeSessions(userId);
      const session = await auth.createSession(userId);
      return { next: onboardingCompleted ? 'dashboard' : 'onboarding', session };
    },

    async changePassword(input) {
      const account = await uow.run((repos) => repos.users.findAccount(input.userId), {
        readOnly: true,
      });
      const currentHash = account?.passwordHash ?? null;
      const valid =
        currentHash !== null && (await auth.verifyPassword(currentHash, input.currentPassword));
      if (account === null || !valid) {
        throw new AppError('INVALID_CURRENT_PASSWORD');
      }
      const passwordHash = await auth.hashPassword(input.newPassword);
      await uow.run(async (repos) => {
        await repos.users.setPassword(account.id, passwordHash);
        await repos.emailOutbox.enqueue({
          id: uuidv7(),
          to: account.email,
          kind: 'password_changed',
          payload: {},
        });
      });
      await auth.revokeSessions(account.id, input.sessionId);
    },
  };
}
