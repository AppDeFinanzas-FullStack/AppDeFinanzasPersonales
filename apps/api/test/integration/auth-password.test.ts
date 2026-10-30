import { createHash, createHmac, randomUUID } from 'node:crypto';

import { afterAll, describe, expect, it } from 'vitest';

import { AppError } from '../../src/application/errors.js';
import type { CreatedSession } from '../../src/application/ports/auth-gateway.js';
import {
  type AuthService,
  createAuthService,
  type SignUpInput,
} from '../../src/application/services/auth.service.js';
import { createBetterAuthGateway } from '../../src/infrastructure/auth/better-auth.js';
import { createEmailLinkRepository } from '../../src/infrastructure/persistence/repositories/email-link.repository.js';
import { createEmailOutboxRepository } from '../../src/infrastructure/persistence/repositories/email-outbox.repository.js';
import { createEmailSendLogRepository } from '../../src/infrastructure/persistence/repositories/email-send-log.repository.js';
import { createLoginThrottleRepository } from '../../src/infrastructure/persistence/repositories/login-throttle.repository.js';
import { createSignupTicketRepository } from '../../src/infrastructure/persistence/repositories/signup-ticket.repository.js';
import { createUserRepository } from '../../src/infrastructure/persistence/repositories/user.repository.js';
import { createUnitOfWork } from '../../src/infrastructure/persistence/unit-of-work.js';
import { disconnectTestPrisma, testPrisma } from './setup/db.js';

/**
 * The plan fixes `POST /api/auth/password/forgot`, `/reset` and `/change` (§4.1.2) with the inputs
 * `ForgotInput { email }`, `ResetInput { token, newPassword }` and `ChangePwdInput { currentPassword,
 * newPassword }` (§4.1.1), but not the names of the service pieces. These tests use
 * `createAuthService({ uow, auth, hmacSecret, webOrigin })` (TASK-054) with:
 * - `forgotPassword({ email })`, which always resolves (the neutral 202) and, when the email has an
 *   account, leaves a `reset` email in the outbox whose `payload.link` carries the token of a new
 *   `reset_password` link of 1 hour, invalidating the previous one;
 * - `resetPassword({ token, newPassword })`, which resolves `{ next, session }` with the new session
 *   `{ sessionId, token, cookie }` of the gateway, or rejects with an `AppError` `LINK_INVALID`;
 * - `changePassword({ userId, sessionId, currentPassword, newPassword })`, where `userId` and
 *   `sessionId` come from the session of the request; it resolves (the 204) or rejects with
 *   `INVALID_CURRENT_PASSWORD`.
 * Accounts are made through `signUp` (and `confirm` for the active ones); sessions through `signIn`.
 * Since TASK-265 `signUp` also resolves the `ticket` of the registration and
 * `confirmationStatus(ticket)` resolves `{ status: 'pending' }` or `{ status: 'confirmed', next,
 * session }`; the reset deletes the tickets of the user (EC-M1-14).
 * Time is the database's: tests move it by editing the rows.
 */
const HMAC_SECRET = 'hmac-secret-for-the-password-test';
const WEB_ORIGIN = 'https://app.finanzas.test';
const PASSWORD = 'Clave-segura-123';
const NEW_PASSWORD = 'Clave-nueva-456';
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
  signupTickets: createSignupTicketRepository(tx),
  users: createUserRepository(tx),
}));

/** The password operations these tests drive, as described above. */
interface PasswordOperations {
  forgotPassword(input: { email: string }): Promise<void>;
  resetPassword(input: {
    token: string;
    newPassword: string;
  }): Promise<{ next: string; session: CreatedSession }>;
  changePassword(input: {
    userId: string;
    sessionId: string;
    currentPassword: string;
    newPassword: string;
  }): Promise<void>;
}

/** The registration ticket (RF-M1-18), as described above. */
interface TicketOperations {
  signUp(input: SignUpInput): Promise<{ status: 'check_email'; ticket: string }>;
  confirmationStatus(
    ticket: string | undefined,
    currentSessionId?: string,
  ): Promise<{ status: 'pending' } | { status: 'confirmed'; next: 'onboarding'; session: CreatedSession }>;
}

const service = createAuthService({
  uow,
  auth,
  hmacSecret: HMAC_SECRET,
  webOrigin: WEB_ORIGIN,
}) as TicketOperations & AuthService & PasswordOperations;

const usedEmails = new Set<string>();

const hmacOf = (email: string) =>
  createHmac('sha256', HMAC_SECRET).update(email.trim().toLowerCase()).digest('hex');

const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');

const tokenIn = (link: string | null): string => {
  const match = /[A-Za-z0-9_-]{43}/.exec(link ?? '');
  if (!match) throw new Error(`no token in link ${String(link)}`);
  return match[0];
};

function freshEmail(): string {
  const email = `${randomUUID()}@password.test`;
  usedEmails.add(email);
  return email;
}

interface UserRow {
  id: string;
  verified: boolean;
}

async function userOf(email: string): Promise<UserRow> {
  const rows = await testPrisma().$queryRaw<UserRow[]>`
    SELECT id::text AS id, email_verified AS verified FROM auth_user WHERE email = ${email}`;
  expect(rows).toHaveLength(1);
  return rows[0] as UserRow;
}

async function sessionIdsOf(userId: string): Promise<string[]> {
  const rows = await testPrisma().$queryRaw<{ id: string }[]>`
    SELECT id::text AS id FROM auth_session WHERE user_id = ${userId}::uuid`;
  return rows.map((row) => row.id);
}

async function ticketCountOf(userId: string): Promise<number> {
  const rows = await testPrisma().$queryRaw<{ n: number }[]>`
    SELECT count(*)::int AS n FROM signup_ticket WHERE user_id = ${userId}::uuid`;
  return rows[0]?.n ?? 0;
}

async function outboxCount(email: string, kind: string): Promise<number> {
  const rows = await testPrisma().$queryRaw<{ n: number }[]>`
    SELECT count(*)::int AS n FROM email_outbox
    WHERE to_address = ${email} AND kind = ${kind}::email_kind`;
  return rows[0]?.n ?? 0;
}

async function linksOf(email: string, kind: 'confirm' | 'reset'): Promise<string[]> {
  const rows = await testPrisma().$queryRaw<{ link: string | null }[]>`
    SELECT payload->>'link' AS link FROM email_outbox
    WHERE to_address = ${email} AND kind = ${kind}::email_kind
    ORDER BY created_at, id`;
  return rows.map((row) => tokenIn(row.link));
}

async function latestLink(email: string, kind: 'confirm' | 'reset'): Promise<string> {
  const tokens = await linksOf(email, kind);
  const token = tokens[tokens.length - 1];
  if (token === undefined) throw new Error(`no ${kind} email for ${email}`);
  return token;
}

interface ResetLinkRow {
  tokenHash: string;
  lifetimeSeconds: number;
  active: boolean;
}

async function resetLinksOf(userId: string): Promise<ResetLinkRow[]> {
  const rows = await testPrisma().$queryRaw<ResetLinkRow[]>`
    SELECT token_hash AS "tokenHash",
           extract(epoch FROM expires_at - created_at)::int AS "lifetimeSeconds",
           (used_at IS NULL AND invalidated_at IS NULL) AS active
    FROM email_link
    WHERE user_id = ${userId}::uuid AND purpose = 'reset_password'::email_link_purpose`;
  return rows.map((row) => ({ ...row, tokenHash: row.tokenHash.trim() }));
}

/** Moves the expiry of the link of that token to `now() + offset` (a negative offset expires it). */
async function setLinkExpiry(token: string, offset: string): Promise<void> {
  await testPrisma().$executeRawUnsafe(
    `UPDATE email_link SET expires_at = now() + interval '${offset}' WHERE token_hash = $1`,
    sha256(token),
  );
}

/** An account registered with `PASSWORD` that never confirmed its email. */
async function pendingAccount(): Promise<{ email: string; userId: string }> {
  const email = freshEmail();
  await service.signUp({ name: 'Ana Pérez', email, password: PASSWORD, termsAccepted: true });
  return { email, userId: (await userOf(email)).id };
}

/** A confirmed account with `PASSWORD` and no open session. */
async function activeAccount(): Promise<{ email: string; userId: string }> {
  const account = await pendingAccount();
  await service.confirm(await latestLink(account.email, 'confirm'));
  await auth.revokeSessions(account.userId);
  expect(await sessionIdsOf(account.userId)).toEqual([]);
  return account;
}

/** Asks for a recovery link and returns its token. */
async function forgot(email: string): Promise<string> {
  await service.forgotPassword({ email });
  return latestLink(email, 'reset');
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

async function signInCode(email: string, password: string): Promise<string> {
  try {
    await service.signIn({ email, password });
    return 'OK';
  } catch (error) {
    expect(error).toBeInstanceOf(AppError);
    return (error as AppError).code;
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

describe('password forgot', () => {
  it('RF-M1-09 forgot leaves a reset email whose link is a recovery link of 1 hour', async () => {
    const { email, userId } = await activeAccount();

    await service.forgotPassword({ email });

    const tokens = await linksOf(email, 'reset');
    expect(tokens).toHaveLength(1);
    const links = await resetLinksOf(userId);
    expect(links).toHaveLength(1);
    expect(links[0]?.tokenHash).toBe(sha256(tokens[0] as string));
    expect(links[0]?.lifetimeSeconds).toBe(60 * 60);
    expect(links[0]?.active).toBe(true);
  });

  it('RF-M1-09 forgot accepts the email in any case and with spaces', async () => {
    const { email } = await activeAccount();

    await service.forgotPassword({ email: `  ${email.toUpperCase()} ` });

    expect(await linksOf(email, 'reset')).toHaveLength(1);
  });

  it('RF-M1-09 forgot for an email without an account resolves and sends nothing', async () => {
    const email = freshEmail();

    await service.forgotPassword({ email });

    expect(await outboxCount(email, 'reset')).toBe(0);
  });

  it('RF-M1-09 asking for a new link invalidates the previous one', async () => {
    const { email, userId } = await activeAccount();
    const first = await forgot(email);

    const second = await forgot(email);

    expect(second).not.toBe(first);
    const active = (await resetLinksOf(userId)).filter((link) => link.active);
    expect(active.map((link) => link.tokenHash)).toEqual([sha256(second)]);
    const error = await rejectionOf(
      service.resetPassword({ token: first, newPassword: NEW_PASSWORD }),
    );
    expect(error.code).toBe('LINK_INVALID');
    expect(await signInCode(email, PASSWORD)).toBe('OK');
  });
});

describe('password reset: the link', () => {
  it('RF-M1-09 el enlace vence a la hora: an expired recovery link gives LINK_INVALID and keeps the password', async () => {
    const { email, userId } = await activeAccount();
    const token = await forgot(email);
    await setLinkExpiry(token, '-1 second');

    const error = await rejectionOf(service.resetPassword({ token, newPassword: NEW_PASSWORD }));

    expect(error.code).toBe('LINK_INVALID');
    expect(error.status).toBe(410);
    expect(await sessionIdsOf(userId)).toEqual([]);
    expect(await outboxCount(email, 'password_changed')).toBe(0);
    expect(await signInCode(email, PASSWORD)).toBe('OK');
    expect(await signInCode(email, NEW_PASSWORD)).toBe('INVALID_CREDENTIALS');
  });

  it('RF-M1-09 a recovery link still works a minute before it expires', async () => {
    const { email } = await activeAccount();
    const token = await forgot(email);
    await setLinkExpiry(token, '1 minute');

    const result = await service.resetPassword({ token, newPassword: NEW_PASSWORD });

    expect(result.session.sessionId).toBeTruthy();
    expect(await signInCode(email, NEW_PASSWORD)).toBe('OK');
  });

  it('RF-M1-09 a recovery link serves only once', async () => {
    const { email } = await activeAccount();
    const token = await forgot(email);
    await service.resetPassword({ token, newPassword: NEW_PASSWORD });

    const error = await rejectionOf(service.resetPassword({ token, newPassword: PASSWORD }));

    expect(['LINK_INVALID', 'LINK_ALREADY_USED']).toContain(error.code);
    expect(await signInCode(email, NEW_PASSWORD)).toBe('OK');
    expect(await signInCode(email, PASSWORD)).toBe('INVALID_CREDENTIALS');
  });

  it('RF-M1-09 a token that was never issued gives LINK_INVALID', async () => {
    const error = await rejectionOf(
      service.resetPassword({ token: 'x'.repeat(43), newPassword: NEW_PASSWORD }),
    );

    expect(error.code).toBe('LINK_INVALID');
    expect(error.status).toBe(410);
  });

  it('RF-M1-09 a confirmation link does not serve to reset the password', async () => {
    const { email } = await pendingAccount();
    const confirmToken = await latestLink(email, 'confirm');

    const error = await rejectionOf(
      service.resetPassword({ token: confirmToken, newPassword: NEW_PASSWORD }),
    );

    expect(error.code).toBe('LINK_INVALID');
    expect((await userOf(email)).verified).toBe(false);
  });
});

describe('password reset: sessions and notice', () => {
  it('RF-M1-10 Recuperar la contraseña cierra las demás sesiones: 1 new session, 0 previous and one password_changed', async () => {
    const { email, userId } = await activeAccount();
    const phone = await service.signIn({ email, password: PASSWORD });
    const computer = await service.signIn({ email, password: PASSWORD });
    const token = await forgot(email);

    const result = await service.resetPassword({ token, newPassword: NEW_PASSWORD });

    expect(await sessionIdsOf(userId)).toEqual([result.session.sessionId]);
    expect(result.session.sessionId).not.toBe(phone.session.sessionId);
    expect(result.session.sessionId).not.toBe(computer.session.sessionId);
    expect(await auth.getSession(phone.session.token)).toBeNull();
    expect(await auth.getSession(computer.session.token)).toBeNull();
    expect((await auth.getSession(result.session.token))?.userId).toBe(userId);
    expect(result.session.cookie).toMatch(/HttpOnly/i);
    expect(await outboxCount(email, 'password_changed')).toBe(1);
  });

  it('RF-M1-10 after the reset the new password signs in and the old one does not', async () => {
    const { email } = await activeAccount();
    const token = await forgot(email);

    await service.resetPassword({ token, newPassword: NEW_PASSWORD });

    expect(await signInCode(email, NEW_PASSWORD)).toBe('OK');
    expect(await signInCode(email, PASSWORD)).toBe('INVALID_CREDENTIALS');
  });

  it('RNF-25 the reset notifies the owner by email with a single password_changed', async () => {
    const { email } = await activeAccount();
    const token = await forgot(email);

    await service.resetPassword({ token, newPassword: NEW_PASSWORD });

    expect(await outboxCount(email, 'password_changed')).toBe(1);
  });

  it('RF-M1-10 the reset does not touch the sessions of another user', async () => {
    const owner = await activeAccount();
    const stranger = await activeAccount();
    const kept = await service.signIn({ email: stranger.email, password: PASSWORD });
    const token = await forgot(owner.email);

    await service.resetPassword({ token, newPassword: NEW_PASSWORD });

    expect(await sessionIdsOf(stranger.userId)).toEqual([kept.session.sessionId]);
    expect(await outboxCount(stranger.email, 'password_changed')).toBe(0);
  });

  it('EC-M1-10 recovering the password of an unconfirmed account leaves it active', async () => {
    const { email, userId } = await pendingAccount();
    const token = await forgot(email);

    const result = await service.resetPassword({ token, newPassword: NEW_PASSWORD });

    expect((await userOf(email)).verified).toBe(true);
    expect(await sessionIdsOf(userId)).toEqual([result.session.sessionId]);
    expect((await auth.getSession(result.session.token))?.userId).toBe(userId);
    expect(await signInCode(email, NEW_PASSWORD)).toBe('OK');
  });

  it('EC-M1-10 a failed reset leaves the unconfirmed account unconfirmed', async () => {
    const { email, userId } = await pendingAccount();
    const token = await forgot(email);
    await setLinkExpiry(token, '-1 second');

    await rejectionOf(service.resetPassword({ token, newPassword: NEW_PASSWORD }));

    expect((await userOf(email)).verified).toBe(false);
    expect(await sessionIdsOf(userId)).toEqual([]);
  });
});

describe('password reset: the registration ticket', () => {
  it('EC-M1-14 EC-M1-10 recovering the password of an unconfirmed account invalidates the ticket of its registration', async () => {
    const email = freshEmail();
    const { ticket } = await service.signUp({
      name: 'Ana Pérez',
      email,
      password: PASSWORD,
      termsAccepted: true,
    });
    const { id: userId } = await userOf(email);
    const token = await forgot(email);

    const reset = await service.resetPassword({ token, newPassword: NEW_PASSWORD });

    expect(await ticketCountOf(userId)).toBe(0);
    expect(await service.confirmationStatus(ticket)).toEqual({ status: 'pending' });
    expect(await sessionIdsOf(userId)).toEqual([reset.session.sessionId]);
  });

  it('EC-M1-14 EC-M1-10 a ticket already confirmed no longer opens a session after the reset', async () => {
    const email = freshEmail();
    const { ticket } = await service.signUp({
      name: 'Ana Pérez',
      email,
      password: PASSWORD,
      termsAccepted: true,
    });
    const { id: userId } = await userOf(email);
    await service.confirm(await latestLink(email, 'confirm'));
    const token = await forgot(email);

    const reset = await service.resetPassword({ token, newPassword: NEW_PASSWORD });

    expect(await service.confirmationStatus(ticket)).toEqual({ status: 'pending' });
    expect(await sessionIdsOf(userId)).toEqual([reset.session.sessionId]);
  });

  it('EC-M1-14 a failed reset keeps the ticket of the registration', async () => {
    const email = freshEmail();
    await service.signUp({ name: 'Ana Pérez', email, password: PASSWORD, termsAccepted: true });
    const { id: userId } = await userOf(email);
    const token = await forgot(email);
    await setLinkExpiry(token, '-1 second');

    await rejectionOf(service.resetPassword({ token, newPassword: NEW_PASSWORD }));

    expect(await ticketCountOf(userId)).toBe(1);
  });
});

describe('password change', () => {
  it('EC-M1-05 after the change on device A the session of device B no longer exists', async () => {
    const { email, userId } = await activeAccount();
    const deviceA = await service.signIn({ email, password: PASSWORD });
    const deviceB = await service.signIn({ email, password: PASSWORD });

    await service.changePassword({
      userId,
      sessionId: deviceA.session.sessionId,
      currentPassword: PASSWORD,
      newPassword: NEW_PASSWORD,
    });

    expect(await auth.getSession(deviceB.session.token)).toBeNull();
    expect(await sessionIdsOf(userId)).toEqual([deviceA.session.sessionId]);
    expect((await auth.getSession(deviceA.session.token))?.userId).toBe(userId);
  });

  it('RF-M1-10 the change revokes every other session, keeps the current one and sends password_changed', async () => {
    const { email, userId } = await activeAccount();
    const current = await service.signIn({ email, password: PASSWORD });
    await service.signIn({ email, password: PASSWORD });
    await service.signIn({ email, password: PASSWORD });

    await service.changePassword({
      userId,
      sessionId: current.session.sessionId,
      currentPassword: PASSWORD,
      newPassword: NEW_PASSWORD,
    });

    expect(await sessionIdsOf(userId)).toEqual([current.session.sessionId]);
    expect(await outboxCount(email, 'password_changed')).toBe(1);
  });

  it('RF-M1-10 after the change the new password signs in and the old one does not', async () => {
    const { email, userId } = await activeAccount();
    const current = await service.signIn({ email, password: PASSWORD });

    await service.changePassword({
      userId,
      sessionId: current.session.sessionId,
      currentPassword: PASSWORD,
      newPassword: NEW_PASSWORD,
    });

    expect(await signInCode(email, PASSWORD)).toBe('INVALID_CREDENTIALS');
    expect(await signInCode(email, NEW_PASSWORD)).toBe('OK');
  });

  it('RNF-25 the change notifies the owner by email with a single password_changed', async () => {
    const { email, userId } = await activeAccount();
    const current = await service.signIn({ email, password: PASSWORD });

    await service.changePassword({
      userId,
      sessionId: current.session.sessionId,
      currentPassword: PASSWORD,
      newPassword: NEW_PASSWORD,
    });

    expect(await outboxCount(email, 'password_changed')).toBe(1);
  });

  it('TASK-057 a wrong current password gives INVALID_CURRENT_PASSWORD and changes nothing', async () => {
    const { email, userId } = await activeAccount();
    const current = await service.signIn({ email, password: PASSWORD });
    const other = await service.signIn({ email, password: PASSWORD });

    const error = await rejectionOf(
      service.changePassword({
        userId,
        sessionId: current.session.sessionId,
        currentPassword: WRONG_PASSWORD,
        newPassword: NEW_PASSWORD,
      }),
    );

    expect(error.code).toBe('INVALID_CURRENT_PASSWORD');
    expect(error.status).toBe(401);
    expect((await sessionIdsOf(userId)).sort()).toEqual(
      [current.session.sessionId, other.session.sessionId].sort(),
    );
    expect(await outboxCount(email, 'password_changed')).toBe(0);
    expect(await signInCode(email, NEW_PASSWORD)).toBe('INVALID_CREDENTIALS');
  });

  it('RF-M1-10 the change does not touch the sessions of another user', async () => {
    const owner = await activeAccount();
    const stranger = await activeAccount();
    const current = await service.signIn({ email: owner.email, password: PASSWORD });
    const kept = await service.signIn({ email: stranger.email, password: PASSWORD });

    await service.changePassword({
      userId: owner.userId,
      sessionId: current.session.sessionId,
      currentPassword: PASSWORD,
      newPassword: NEW_PASSWORD,
    });

    expect(await sessionIdsOf(stranger.userId)).toEqual([kept.session.sessionId]);
    expect(await signInCode(stranger.email, PASSWORD)).toBe('OK');
  });
});
