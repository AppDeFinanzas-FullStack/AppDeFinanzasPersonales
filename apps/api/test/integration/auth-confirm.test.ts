import { createHash, createHmac, randomUUID } from 'node:crypto';

import { afterAll, describe, expect, it } from 'vitest';

import { AppError } from '../../src/application/errors.js';
import { createAuthService } from '../../src/application/services/auth.service.js';
import { createBetterAuthGateway } from '../../src/infrastructure/auth/better-auth.js';
import { createEmailLinkRepository } from '../../src/infrastructure/persistence/repositories/email-link.repository.js';
import { createEmailOutboxRepository } from '../../src/infrastructure/persistence/repositories/email-outbox.repository.js';
import { createEmailSendLogRepository } from '../../src/infrastructure/persistence/repositories/email-send-log.repository.js';
import { createLoginThrottleRepository } from '../../src/infrastructure/persistence/repositories/login-throttle.repository.js';
import { createUserRepository } from '../../src/infrastructure/persistence/repositories/user.repository.js';
import { createUnitOfWork } from '../../src/infrastructure/persistence/unit-of-work.js';
import { createUser, deleteCreatedUsers } from '../factories/user.factory.js';
import { disconnectTestPrisma, testPrisma } from './setup/db.js';

/**
 * The plan fixes `POST /api/auth/confirmation/resend` and `POST /api/auth/confirm` (§4.1.2) and the
 * single-use link (§4.1.3), but not the names of the pieces. These tests use:
 * - `createAuthService({ uow, auth, hmacSecret, webOrigin })` (TASK-054) with:
 *   - `resendConfirmation({ email } | { token })`, which always resolves (the neutral 202), and
 *     sends a new `confirm` email only within the limits of 60 s and 5 per hour;
 *   - `confirm(token, currentSessionId?)`, which resolves `{ next: 'onboarding', session }` with the
 *     new session `{ sessionId, token, cookie }` of the gateway, or rejects with an `AppError`
 *     `LINK_INVALID` (data `{ canResend }`) or `LINK_ALREADY_USED`;
 * - the repository of `email_send_log`, `createEmailSendLogRepository(tx)`, exposed as
 *   `repos.emailSendLog` next to the others over one `UnitOfWork`;
 * - the real Better Auth gateway over the test database.
 * As in the sign-up, the key of `email_send_log` is the lowercase hex HMAC-SHA256 of the normalized
 * email under `hmacSecret`. Time is the database's: tests move it by editing the rows.
 */
const HMAC_SECRET = 'hmac-secret-for-the-confirm-test';
const WEB_ORIGIN = 'https://app.finanzas.test';
const PASSWORD = 'Clave-segura-123';

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
const service = createAuthService({
  uow,
  auth,
  hmacSecret: HMAC_SECRET,
  webOrigin: WEB_ORIGIN,
});

const usedEmails = new Set<string>();

const hmacOf = (email: string) =>
  createHmac('sha256', HMAC_SECRET).update(email.trim().toLowerCase()).digest('hex');

const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');

const tokenIn = (link: string | null): string => {
  const match = /[A-Za-z0-9_-]{43}/.exec(link ?? '');
  if (!match) throw new Error(`no token in link ${String(link)}`);
  return match[0];
};

async function confirmLinksOf(email: string): Promise<string[]> {
  const rows = await testPrisma().$queryRaw<{ link: string | null }[]>`
    SELECT payload->>'link' AS link FROM email_outbox
    WHERE to_address = ${email} AND kind = 'confirm'::email_kind
    ORDER BY created_at, id`;
  return rows.map((row) => tokenIn(row.link));
}

async function latestToken(email: string): Promise<string> {
  const tokens = await confirmLinksOf(email);
  const token = tokens[tokens.length - 1];
  if (token === undefined) throw new Error(`no confirm email for ${email}`);
  return token;
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

async function activeLinkHashes(userId: string): Promise<string[]> {
  const rows = await testPrisma().$queryRaw<{ tokenHash: string }[]>`
    SELECT token_hash AS "tokenHash" FROM email_link
    WHERE user_id = ${userId}::uuid AND purpose = 'confirm_email'::email_link_purpose
      AND used_at IS NULL AND invalidated_at IS NULL`;
  return rows.map((row) => row.tokenHash.trim());
}

/** Moves every send of that email back in time by the given interval. */
async function backdateSends(email: string, interval: string): Promise<void> {
  await testPrisma().$executeRawUnsafe(
    `UPDATE email_send_log SET sent_at = sent_at - interval '${interval}' WHERE email_hmac = $1`,
    hmacOf(email),
  );
}

async function expireLink(token: string): Promise<void> {
  await testPrisma().$executeRaw`
    UPDATE email_link SET expires_at = now() - interval '1 second'
    WHERE token_hash = ${sha256(token)}`;
}

/**
 * Registers an unconfirmed account and moves any send of its sign-up two hours back, so the first
 * resend of each test starts outside both limits.
 */
async function pendingAccount(): Promise<{ email: string; userId: string }> {
  const email = `${randomUUID()}@confirm.test`;
  usedEmails.add(email);
  await service.signUp({ name: 'Ana Pérez', email, password: PASSWORD, termsAccepted: true });
  await backdateSends(email, '2 hours');
  const user = await userOf(email);
  return { email, userId: user.id };
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

afterAll(async () => {
  const emails = [...usedEmails];
  await testPrisma().$executeRaw`DELETE FROM auth_user WHERE email = ANY(${emails}::text[])`;
  await testPrisma()
    .$executeRaw`DELETE FROM email_outbox WHERE to_address = ANY(${emails}::text[])`;
  await testPrisma().$executeRaw`
    DELETE FROM email_send_log WHERE email_hmac = ANY(${emails.map(hmacOf)}::text[])`;
  await deleteCreatedUsers();
  await disconnectTestPrisma();
});

describe('confirmation resend: limits', () => {
  it('RF-M1-05 a resend outside the limits sends a new confirm email and invalidates the previous link', async () => {
    const { email, userId } = await pendingAccount();
    const [first] = await confirmLinksOf(email);

    await service.resendConfirmation({ email });

    const tokens = await confirmLinksOf(email);
    expect(tokens).toHaveLength(2);
    const latest = tokens[1] as string;
    expect(latest).not.toBe(first);
    expect(await activeLinkHashes(userId)).toEqual([sha256(latest)]);
  });

  it('RF-M1-05 the resend accepts the email in any case and with spaces', async () => {
    const { email } = await pendingAccount();

    await service.resendConfirmation({ email: `  ${email.toUpperCase()} ` });

    expect(await confirmLinksOf(email)).toHaveLength(2);
  });

  it('RF-M1-05 a resend 30 seconds after the previous one sends nothing and keeps the link', async () => {
    const { email, userId } = await pendingAccount();
    await service.resendConfirmation({ email });
    const latest = await latestToken(email);
    await backdateSends(email, '30 seconds');

    await service.resendConfirmation({ email });

    expect(await confirmLinksOf(email)).toHaveLength(2);
    expect(await activeLinkHashes(userId)).toEqual([sha256(latest)]);
  });

  it('RF-M1-05 a resend 61 seconds after the previous one sends a new email', async () => {
    const { email } = await pendingAccount();
    await service.resendConfirmation({ email });
    await backdateSends(email, '61 seconds');

    await service.resendConfirmation({ email });

    expect(await confirmLinksOf(email)).toHaveLength(3);
  });

  it('RF-M1-05 after 5 resends in one hour the sixth sends nothing', async () => {
    const { email, userId } = await pendingAccount();
    for (let i = 0; i < 5; i += 1) {
      await service.resendConfirmation({ email });
      await backdateSends(email, '2 minutes');
    }
    expect(await confirmLinksOf(email)).toHaveLength(6);
    const fifth = await latestToken(email);

    await service.resendConfirmation({ email });

    expect(await confirmLinksOf(email)).toHaveLength(6);
    expect(await activeLinkHashes(userId)).toEqual([sha256(fifth)]);
  });

  it('RF-M1-05 once the 5 resends are more than an hour old a new resend is sent', async () => {
    const { email } = await pendingAccount();
    for (let i = 0; i < 5; i += 1) {
      await service.resendConfirmation({ email });
      await backdateSends(email, '2 minutes');
    }
    await backdateSends(email, '1 hour');

    await service.resendConfirmation({ email });

    expect(await confirmLinksOf(email)).toHaveLength(7);
  });

  it('RF-M1-05 a resend blocked by the limits still resolves like the others', async () => {
    const { email } = await pendingAccount();
    await service.resendConfirmation({ email });

    await service.resendConfirmation({ email });
  });

  it('RF-M1-05 a resend for an email without an account resolves and sends nothing', async () => {
    const email = `${randomUUID()}@confirm.test`;
    usedEmails.add(email);

    await service.resendConfirmation({ email });

    expect(await confirmLinksOf(email)).toHaveLength(0);
  });

  it('RF-M1-05 the limits are per account: another account can resend at the same time', async () => {
    const first = await pendingAccount();
    const second = await pendingAccount();
    await service.resendConfirmation({ email: first.email });

    await service.resendConfirmation({ email: second.email });

    expect(await confirmLinksOf(first.email)).toHaveLength(2);
    expect(await confirmLinksOf(second.email)).toHaveLength(2);
  });

  it('RF-M1-05 the send log keeps the HMAC of the email, never the email in clear', async () => {
    const { email } = await pendingAccount();
    await service.resendConfirmation({ email });

    const rows = await testPrisma().$queryRaw<{ n: number }[]>`
      SELECT count(*)::int AS n FROM email_send_log WHERE email_hmac = ${hmacOf(email)}`;
    expect(rows[0]?.n).toBeGreaterThan(0);
    const leaked = await testPrisma().$queryRaw<{ n: number }[]>`
      SELECT count(*)::int AS n FROM email_send_log WHERE email_hmac LIKE ${'%confirm.test%'}`;
    expect(leaked[0]?.n).toBe(0);
  });
});

describe('confirmation resend: by token', () => {
  it('EC-M1-01 a resend with the token of an expired link sends a new link that confirms', async () => {
    const { email, userId } = await pendingAccount();
    const expired = await latestToken(email);
    await expireLink(expired);

    await service.resendConfirmation({ token: expired });

    const tokens = await confirmLinksOf(email);
    expect(tokens).toHaveLength(2);
    const fresh = tokens[1] as string;
    expect(await activeLinkHashes(userId)).toEqual([sha256(fresh)]);
    const result = await service.confirm(fresh);
    expect(result.next).toBe('onboarding');
  });

  it('RF-M1-05 a resend by token respects the 60 second limit of the account', async () => {
    const { email } = await pendingAccount();
    const token = await latestToken(email);
    await service.resendConfirmation({ email });
    await backdateSends(email, '30 seconds');

    await service.resendConfirmation({ token });

    expect(await confirmLinksOf(email)).toHaveLength(2);
  });

  it('RF-M1-05 a resend with an unknown token resolves and sends nothing', async () => {
    const { email } = await pendingAccount();

    await service.resendConfirmation({ token: 'x'.repeat(43) });

    expect(await confirmLinksOf(email)).toHaveLength(1);
  });
});

describe('confirm', () => {
  it('RF-M1-04 the account is not active and has no session after signing up or resending', async () => {
    const { email, userId } = await pendingAccount();
    await service.resendConfirmation({ email });

    expect((await userOf(email)).verified).toBe(false);
    expect(await sessionIdsOf(userId)).toEqual([]);
  });

  it('RF-M1-04 confirming marks the email as verified and opens a session', async () => {
    const { email, userId } = await pendingAccount();
    const token = await latestToken(email);

    const result = await service.confirm(token);

    expect(result.next).toBe('onboarding');
    expect((await userOf(email)).verified).toBe(true);
    expect(await sessionIdsOf(userId)).toEqual([result.session.sessionId]);
    const resolved = await auth.getSession(result.session.token);
    expect(resolved?.userId).toBe(userId);
    expect(result.session.cookie).toMatch(/HttpOnly/i);
  });

  it('RF-M1-04 a failed confirmation leaves the account unconfirmed and without a session', async () => {
    const { email, userId } = await pendingAccount();
    const token = await latestToken(email);
    await expireLink(token);

    await rejectionOf(service.confirm(token));

    expect((await userOf(email)).verified).toBe(false);
    expect(await sessionIdsOf(userId)).toEqual([]);
  });

  it('EC-M1-01 an expired link gives LINK_INVALID and offers to resend', async () => {
    const { email } = await pendingAccount();
    const token = await latestToken(email);
    await expireLink(token);

    const error = await rejectionOf(service.confirm(token));

    expect(error.code).toBe('LINK_INVALID');
    expect(error.status).toBe(410);
    expect(error.data).toMatchObject({ canResend: true });
  });

  it('EC-M1-01 a link invalidated by a resend gives LINK_INVALID and offers to resend', async () => {
    const { email } = await pendingAccount();
    const old = await latestToken(email);
    await service.resendConfirmation({ email });

    const error = await rejectionOf(service.confirm(old));

    expect(error.code).toBe('LINK_INVALID');
    expect(error.data).toMatchObject({ canResend: true });
    expect((await userOf(email)).verified).toBe(false);
  });

  it('EC-M1-01 after a resend only the new link confirms', async () => {
    const { email } = await pendingAccount();
    await service.resendConfirmation({ email });
    const fresh = await latestToken(email);

    const result = await service.confirm(fresh);

    expect(result.next).toBe('onboarding');
    expect((await userOf(email)).verified).toBe(true);
  });

  it('EC-M1-02 a link already used with the account active gives LINK_ALREADY_USED and opens no session', async () => {
    const { email, userId } = await pendingAccount();
    const token = await latestToken(email);
    const first = await service.confirm(token);

    const error = await rejectionOf(service.confirm(token));

    expect(error.code).toBe('LINK_ALREADY_USED');
    expect(error.status).toBe(409);
    expect((await userOf(email)).verified).toBe(true);
    expect(await sessionIdsOf(userId)).toEqual([first.session.sessionId]);
  });

  it('EC-M1-11 confirming A on a device with the session of B closes B and opens A', async () => {
    const { email, userId } = await pendingAccount();
    const token = await latestToken(email);
    const other = await createUser();
    const deviceSession = await auth.createSession(other.id);

    const result = await service.confirm(token, deviceSession.sessionId);

    expect(await auth.getSession(deviceSession.token)).toBeNull();
    expect(await sessionIdsOf(other.id)).not.toContain(deviceSession.sessionId);
    expect(await sessionIdsOf(userId)).toEqual([result.session.sessionId]);
    expect((await auth.getSession(result.session.token))?.userId).toBe(userId);
    expect((await userOf(email)).verified).toBe(true);
  });

  it('EC-M1-11 only the session of B on that device is closed, not its other devices', async () => {
    const { email } = await pendingAccount();
    const token = await latestToken(email);
    const other = await createUser();
    const deviceSession = await auth.createSession(other.id);
    const elsewhere = await auth.createSession(other.id);

    await service.confirm(token, deviceSession.sessionId);

    expect(await sessionIdsOf(other.id)).toEqual([elsewhere.sessionId]);
    expect((await auth.getSession(elsewhere.token))?.userId).toBe(other.id);
  });

  it('EC-M1-11 a failed confirmation keeps the session of B on the device', async () => {
    const { email } = await pendingAccount();
    const token = await latestToken(email);
    await expireLink(token);
    const other = await createUser();
    const deviceSession = await auth.createSession(other.id);

    await rejectionOf(service.confirm(token, deviceSession.sessionId));

    expect((await auth.getSession(deviceSession.token))?.userId).toBe(other.id);
  });
});
