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

export interface AuthService {
  /** Always answers the neutral `check_email`, whatever the state of the email (RF-M1-03). */
  signUp(input: SignUpInput): Promise<SignUpResult>;
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
  };
}
