import { createHmac } from 'node:crypto';

import { uuidv7 } from 'uuidv7';

import type { AuthGateway } from '../ports/auth-gateway.js';
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

export interface AuthService {
  /** Always answers the neutral `check_email`, whatever the state of the email (RF-M1-03). */
  signUp(input: SignUpInput): Promise<SignUpResult>;
}

export interface AuthServiceDeps {
  uow: UnitOfWork;
  auth: AuthGateway;
  hmacSecret: string;
  webOrigin: string;
}

/** Every sign-up takes at least this long, so the time does not tell the three cases apart. */
const MIN_SIGN_UP_MILLISECONDS = 300;

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
  };
}
