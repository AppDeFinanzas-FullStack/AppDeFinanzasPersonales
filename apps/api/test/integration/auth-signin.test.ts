import { createHmac, randomUUID } from 'node:crypto';

import { afterAll, describe, expect, it } from 'vitest';

import { AppError } from '../../src/application/errors.js';
import type { CreatedSession } from '../../src/application/ports/auth-gateway.js';
import {
  type AuthService,
  createAuthService,
} from '../../src/application/services/auth.service.js';
import { createBetterAuthGateway } from '../../src/infrastructure/auth/better-auth.js';
import { createEmailLinkRepository } from '../../src/infrastructure/persistence/repositories/email-link.repository.js';
import { createEmailOutboxRepository } from '../../src/infrastructure/persistence/repositories/email-outbox.repository.js';
import { createEmailSendLogRepository } from '../../src/infrastructure/persistence/repositories/email-send-log.repository.js';
import { createLoginThrottleRepository } from '../../src/infrastructure/persistence/repositories/login-throttle.repository.js';
import { createUserRepository } from '../../src/infrastructure/persistence/repositories/user.repository.js';
import { createUnitOfWork } from '../../src/infrastructure/persistence/unit-of-work.js';
import { disconnectTestPrisma, testPrisma } from './setup/db.js';

/**
 * The plan fixes `POST /api/auth/sign-in`, `/sign-out` and `/sign-out-all` (§4.1.2) and the login
 * throttle (§4.1.3), but not the names of the pieces. These tests use `createAuthService({ uow,
 * auth, hmacSecret, webOrigin })` (TASK-054) with:
 * - `signIn({ email, password })`, which resolves an object whose `session` is the new session
 *   `{ sessionId, token, cookie }` of the gateway, or rejects with an `AppError`
 *   `INVALID_CREDENTIALS`, `EMAIL_NOT_CONFIRMED` or `LOGIN_LOCKED` (data `{ retryAfterSeconds }`);
 * - `signOut(sessionId)`, which closes that session;
 * - `signOutAll(userId)`, which closes every session of the user.
 * The key of `login_throttle` is the lowercase hex HMAC-SHA256 of the normalized email under
 * `hmacSecret`. Accounts are made through `signUp` (and `confirm` for the active ones). Time is the
 * database's: tests move it by editing the rows.
 */
const HMAC_SECRET = 'hmac-secret-for-the-sign-in-test';
const WEB_ORIGIN = 'https://app.finanzas.test';
const PASSWORD = 'Clave-segura-123';
const WRONG_PASSWORD = 'Clave-incorrecta-999';

const auth = createBetterAuthGateway({
  prisma: testPrisma(),
  secret: 'test-secret-test-secret-test-secret-0123',
});
const uow = createUnitOfWork(testPrisma(), (tx) => ({
  emailOutbox: createEmailOutboxRepository(tx),
  emailLinks: createEmailLinkRepository(tx),
  emailSendLog: createEmailSendLogRepository(tx),
  loginThrottle: createLoginThrottleRepository(tx),
  users: createUserRepository(tx),
}));
/** The sign-in and sign-out operations these tests drive, as described above. */
interface SignInOperations {
  signIn(input: { email: string; password: string }): Promise<{ session: CreatedSession }>;
  signOut(sessionId: string): Promise<void>;
  signOutAll(userId: string): Promise<void>;
}

const service = createAuthService({
  uow,
  auth,
  hmacSecret: HMAC_SECRET,
  webOrigin: WEB_ORIGIN,
}) as AuthService & SignInOperations;

const usedEmails = new Set<string>();

const hmacOf = (email: string) =>
  createHmac('sha256', HMAC_SECRET).update(email.trim().toLowerCase()).digest('hex');

function freshEmail(): string {
  const email = `${randomUUID()}@signin.test`;
  usedEmails.add(email);
  return email;
}

async function userIdOf(email: string): Promise<string> {
  const rows = await testPrisma().$queryRaw<{ id: string }[]>`
    SELECT id::text AS id FROM auth_user WHERE email = ${email}`;
  expect(rows).toHaveLength(1);
  return (rows[0] as { id: string }).id;
}

async function sessionIdsOf(userId: string): Promise<string[]> {
  const rows = await testPrisma().$queryRaw<{ id: string }[]>`
    SELECT id::text AS id FROM auth_session WHERE user_id = ${userId}::uuid`;
  return rows.map((row) => row.id);
}

/** Every outbox row addressed to that email, of any kind. */
async function outboxRowsOf(email: string): Promise<number> {
  const rows = await testPrisma().$queryRaw<{ n: number }[]>`
    SELECT count(*)::int AS n FROM email_outbox WHERE to_address = ${email}`;
  return rows[0]?.n ?? 0;
}

async function throttleFailuresOf(email: string): Promise<number> {
  const rows = await testPrisma().$queryRaw<{ n: number }[]>`
    SELECT consecutive_failures AS n FROM login_throttle WHERE email_hmac = ${hmacOf(email)}`;
  return rows[0]?.n ?? 0;
}

/** Moves a time column of the throttle row of that email to `now() - interval`. */
async function backdateThrottle(email: string, column: string, interval: string): Promise<void> {
  const allowed = ['last_failure_at', 'locked_until'];
  if (!allowed.includes(column)) throw new Error('unexpected column');
  await testPrisma().$executeRawUnsafe(
    `UPDATE login_throttle SET ${column} = now() - interval '${interval}' WHERE email_hmac = $1`,
    hmacOf(email),
  );
}

async function latestConfirmToken(email: string): Promise<string> {
  const rows = await testPrisma().$queryRaw<{ link: string | null }[]>`
    SELECT payload->>'link' AS link FROM email_outbox
    WHERE to_address = ${email} AND kind = 'confirm'::email_kind
    ORDER BY created_at DESC, id DESC LIMIT 1`;
  const match = /[A-Za-z0-9_-]{43}/.exec(rows[0]?.link ?? '');
  if (!match) throw new Error(`no confirm email for ${email}`);
  return match[0];
}

/** An account registered with `PASSWORD` that never confirmed its email. */
async function pendingAccount(): Promise<{ email: string; userId: string }> {
  const email = freshEmail();
  await service.signUp({ name: 'Ana Pérez', email, password: PASSWORD, termsAccepted: true });
  return { email, userId: await userIdOf(email) };
}

/** A confirmed account with `PASSWORD` and no open session. */
async function activeAccount(): Promise<{ email: string; userId: string }> {
  const account = await pendingAccount();
  await service.confirm(await latestConfirmToken(account.email));
  await auth.revokeSessions(account.userId);
  expect(await sessionIdsOf(account.userId)).toEqual([]);
  return account;
}

async function rejectionOf(promise: Promise<unknown>): Promise<AppError> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(AppError);
    return error as AppError;
  }
  throw new Error('expected the promise to reject');
}

async function failTimes(email: string, times: number): Promise<void> {
  for (let i = 0; i < times; i += 1) {
    const error = await rejectionOf(service.signIn({ email, password: WRONG_PASSWORD }));
    expect(error.code).toBe('INVALID_CREDENTIALS');
  }
}

afterAll(async () => {
  const emails = [...usedEmails];
  await testPrisma().$executeRaw`DELETE FROM auth_user WHERE email = ANY(${emails}::text[])`;
  await testPrisma()
    .$executeRaw`DELETE FROM email_outbox WHERE to_address = ANY(${emails}::text[])`;
  await testPrisma().$executeRaw`
    DELETE FROM email_send_log WHERE email_hmac = ANY(${emails.map(hmacOf)}::text[])`;
  await testPrisma().$executeRaw`
    DELETE FROM login_throttle WHERE email_hmac = ANY(${emails.map(hmacOf)}::text[])`;
  await disconnectTestPrisma();
});

describe('sign-in: success and unconfirmed email', () => {
  it('RF-M1-07 the right password of an active account opens a session', async () => {
    const { email, userId } = await activeAccount();

    const result = await service.signIn({ email, password: PASSWORD });

    expect(await sessionIdsOf(userId)).toEqual([result.session.sessionId]);
    expect((await auth.getSession(result.session.token))?.userId).toBe(userId);
    expect(result.session.cookie).toMatch(/HttpOnly/i);
  });

  it('RF-M1-07 signing in on two devices keeps both sessions open', async () => {
    const { email, userId } = await activeAccount();

    const first = await service.signIn({ email, password: PASSWORD });
    const second = await service.signIn({ email, password: PASSWORD });

    expect((await sessionIdsOf(userId)).sort()).toEqual(
      [first.session.sessionId, second.session.sessionId].sort(),
    );
    expect((await auth.getSession(first.session.token))?.userId).toBe(userId);
    expect((await auth.getSession(second.session.token))?.userId).toBe(userId);
  });

  it('RF-M1-04 Usuario sin confirmar no accede: EMAIL_NOT_CONFIRMED and no auth_session row', async () => {
    const { email, userId } = await pendingAccount();

    const error = await rejectionOf(service.signIn({ email, password: PASSWORD }));

    expect(error.code).toBe('EMAIL_NOT_CONFIRMED');
    expect(error.status).toBe(403);
    expect(await sessionIdsOf(userId)).toEqual([]);
  });

  it('RF-M1-08 a successful sign-in resets the failure counter', async () => {
    const { email } = await activeAccount();
    await failTimes(email, 3);
    expect(await throttleFailuresOf(email)).toBe(3);

    await service.signIn({ email, password: PASSWORD });

    expect(await throttleFailuresOf(email)).toBe(0);
  });

  it('RF-M1-08 the right password of an unconfirmed account also resets the counter', async () => {
    const { email } = await pendingAccount();
    await failTimes(email, 3);

    await rejectionOf(service.signIn({ email, password: PASSWORD }));

    expect(await throttleFailuresOf(email)).toBe(0);
  });
});

describe('sign-in: failures and waits', () => {
  it('RF-M1-08 a wrong password gives INVALID_CREDENTIALS, counts the failure and opens no session', async () => {
    const { email, userId } = await activeAccount();

    const error = await rejectionOf(service.signIn({ email, password: WRONG_PASSWORD }));

    expect(error.code).toBe('INVALID_CREDENTIALS');
    expect(error.status).toBe(401);
    expect(await throttleFailuresOf(email)).toBe(1);
    expect(await sessionIdsOf(userId)).toEqual([]);
  });

  it('RF-M1-08 Espera progresiva tras intentos fallidos: after 5 failures the next attempt is LOGIN_LOCKED with about 60 s', async () => {
    const { email, userId } = await activeAccount();
    await failTimes(email, 5);

    const error = await rejectionOf(service.signIn({ email, password: WRONG_PASSWORD }));

    expect(error.code).toBe('LOGIN_LOCKED');
    expect(error.status).toBe(429);
    const seconds = error.data?.['retryAfterSeconds'];
    expect(typeof seconds).toBe('number');
    expect(seconds as number).toBeGreaterThanOrEqual(50);
    expect(seconds as number).toBeLessThanOrEqual(60);
    expect(await sessionIdsOf(userId)).toEqual([]);
  });

  it('RF-M1-08 Espera progresiva tras intentos fallidos: after 5 failures LOGIN_LOCKED with about 60 s and no outbox row', async () => {
    const { email } = await activeAccount();
    const before = await outboxRowsOf(email);
    await failTimes(email, 5);

    const error = await rejectionOf(service.signIn({ email, password: WRONG_PASSWORD }));

    expect(error.code).toBe('LOGIN_LOCKED');
    const seconds = error.data?.['retryAfterSeconds'] as number;
    expect(seconds).toBeGreaterThanOrEqual(50);
    expect(seconds).toBeLessThanOrEqual(60);
    expect(await outboxRowsOf(email)).toBe(before);
  });

  it('RF-M1-08 a single failed attempt on an active account enqueues no email', async () => {
    const { email } = await activeAccount();
    const before = await outboxRowsOf(email);

    await failTimes(email, 1);

    expect(await outboxRowsOf(email)).toBe(before);
  });

  it('RF-M1-16 ten failures and the 15 minute wait never enqueue an email', async () => {
    const { email } = await activeAccount();
    const before = await outboxRowsOf(email);
    await failTimes(email, 5);
    await backdateThrottle(email, 'locked_until', '1 second');
    await failTimes(email, 5);
    await rejectionOf(service.signIn({ email, password: WRONG_PASSWORD }));

    expect(await outboxRowsOf(email)).toBe(before);
  });

  it('EC-M1-12 failures for an email without an account are counted and locked the same way, with no email', async () => {
    const email = freshEmail();
    await failTimes(email, 5);

    const error = await rejectionOf(service.signIn({ email, password: WRONG_PASSWORD }));

    expect(error.code).toBe('LOGIN_LOCKED');
    expect(error.status).toBe(429);
    const seconds = error.data?.['retryAfterSeconds'] as number;
    expect(seconds).toBeGreaterThanOrEqual(50);
    expect(seconds).toBeLessThanOrEqual(60);
    expect(await outboxRowsOf(email)).toBe(0);
  });

  it('RF-M1-08 after 10 failures the wait is about 15 minutes', async () => {
    const { email } = await activeAccount();
    await failTimes(email, 5);
    await backdateThrottle(email, 'locked_until', '1 second');
    await failTimes(email, 5);

    const error = await rejectionOf(service.signIn({ email, password: WRONG_PASSWORD }));

    expect(error.code).toBe('LOGIN_LOCKED');
    const seconds = error.data?.['retryAfterSeconds'] as number;
    expect(seconds).toBeGreaterThan(14 * 60);
    expect(seconds).toBeLessThanOrEqual(15 * 60);
  });

  it('RF-M1-08 once the wait is over the right password signs in and resets the counter', async () => {
    const { email, userId } = await activeAccount();
    await failTimes(email, 5);
    await backdateThrottle(email, 'locked_until', '1 second');

    const result = await service.signIn({ email, password: PASSWORD });

    expect(await sessionIdsOf(userId)).toEqual([result.session.sessionId]);
    expect(await throttleFailuresOf(email)).toBe(0);
  });

  it('EC-M1-04 the right password is rejected during the wait, with the time left and no session', async () => {
    const { email, userId } = await activeAccount();
    await failTimes(email, 5);

    const error = await rejectionOf(service.signIn({ email, password: PASSWORD }));

    expect(error.code).toBe('LOGIN_LOCKED');
    expect(error.status).toBe(429);
    expect(error.data?.['retryAfterSeconds']).toBeGreaterThan(0);
    expect(await sessionIdsOf(userId)).toEqual([]);
    expect(await throttleFailuresOf(email)).toBe(5);
  });
});

describe('sign-in: neutral errors', () => {
  it('RNF-15 an email without an account and a wrong password give the same error', async () => {
    const { email } = await activeAccount();
    const unknown = freshEmail();

    const wrongPassword = await rejectionOf(
      service.signIn({ email, password: WRONG_PASSWORD }),
    );
    const noAccount = await rejectionOf(service.signIn({ email: unknown, password: PASSWORD }));

    expect(wrongPassword.code).toBe('INVALID_CREDENTIALS');
    expect(noAccount.code).toBe(wrongPassword.code);
    expect(noAccount.status).toBe(wrongPassword.status);
    expect(noAccount.message).toBe(wrongPassword.message);
    expect(noAccount.data).toEqual(wrongPassword.data);
  });

  it('RNF-15 a wrong password on an unconfirmed account gives INVALID_CREDENTIALS, not EMAIL_NOT_CONFIRMED', async () => {
    const { email } = await pendingAccount();

    const error = await rejectionOf(service.signIn({ email, password: WRONG_PASSWORD }));

    expect(error.code).toBe('INVALID_CREDENTIALS');
  });
});

describe('sign-out', () => {
  it('RF-M1-07 signOut closes only the current session', async () => {
    const { email, userId } = await activeAccount();
    const current = await service.signIn({ email, password: PASSWORD });
    const other = await service.signIn({ email, password: PASSWORD });

    await service.signOut(current.session.sessionId);

    expect(await auth.getSession(current.session.token)).toBeNull();
    expect(await sessionIdsOf(userId)).toEqual([other.session.sessionId]);
    expect((await auth.getSession(other.session.token))?.userId).toBe(userId);
  });

  it('RF-M1-07 signOutAll leaves 0 sessions', async () => {
    const { email, userId } = await activeAccount();
    const sessions = [
      await service.signIn({ email, password: PASSWORD }),
      await service.signIn({ email, password: PASSWORD }),
      await service.signIn({ email, password: PASSWORD }),
    ];

    await service.signOutAll(userId);

    expect(await sessionIdsOf(userId)).toEqual([]);
    for (const { session } of sessions) {
      expect(await auth.getSession(session.token)).toBeNull();
    }
  });

  it('RF-M1-07 signOutAll does not touch the sessions of another user', async () => {
    const owner = await activeAccount();
    const stranger = await activeAccount();
    await service.signIn({ email: owner.email, password: PASSWORD });
    const kept = await service.signIn({ email: stranger.email, password: PASSWORD });

    await service.signOutAll(owner.userId);

    expect(await sessionIdsOf(owner.userId)).toEqual([]);
    expect(await sessionIdsOf(stranger.userId)).toEqual([kept.session.sessionId]);
  });
});
