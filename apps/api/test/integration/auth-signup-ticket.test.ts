import { createHash, createHmac, randomBytes, randomUUID } from 'node:crypto';

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
import { createUser, deleteCreatedUsers } from '../factories/user.factory.js';
import { disconnectTestPrisma, testPrisma } from './setup/db.js';

/**
 * The registration ticket (RF-M1-18, plan §4.1.2, TASK-265): the tab where the user signed up
 * learns about the confirmation through a secret it keeps in a cookie, and that ticket, not the
 * link, opens the session. These tests use:
 * - the repository `createSignupTicketRepository(tx)`, exposed as `repos.signupTickets` over one
 *   `UnitOfWork`, with:
 *   - `issue(userId, tokenHash, expiresAt)`, which replaces the ticket of the user;
 *   - `markConfirmed(userId)`, which marks the ticket of the user as confirmed;
 *   - `claim(tokenHash)`, which deletes a confirmed ticket that has not expired and resolves its
 *     user id, or resolves `null` (unknown, unconfirmed or expired);
 *   - `deleteForUser(userId)` and `purgeExpired(now)`;
 * - `createAuthService({ uow, auth, hmacSecret, webOrigin })` with:
 *   - `signUp(input)`, which resolves `{ status: 'check_email', ticket }` whatever the state of
 *     the email, and keeps the SHA-256 (lowercase hex) of `ticket` only when the account is
 *     unconfirmed, new or replaced;
 *   - `confirm(token)`, which resolves `{ status: 'confirmed' }` without opening a session;
 *   - `confirmationStatus(ticket, currentSessionId?)`, which resolves `{ status: 'pending' }` or,
 *     once the link was opened, `{ status: 'confirmed', next: 'onboarding', session }` with the new
 *     session `{ sessionId, token, cookie }` of the gateway, closing `currentSessionId` (EC-M1-11);
 *   - `forgotPassword` and `resetPassword` as in `auth-password.test.ts`;
 * - the real Better Auth gateway over the test database.
 * Time is the database's: tests move it by editing the rows.
 */
const HMAC_SECRET = 'hmac-secret-for-the-signup-ticket-test';
const WEB_ORIGIN = 'https://app.finanzas.test';
const PASSWORD = 'Clave-segura-123';
const NEW_PASSWORD = 'Clave-nueva-456';
const DAY_SECONDS = 24 * 60 * 60;

/** 32 random bytes, in base64url or in hex. */
const TICKET = /^(?:[A-Za-z0-9_-]{43}|[0-9a-f]{64})$/;

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

type ConfirmationStatus =
  | { status: 'pending' }
  | { status: 'confirmed'; next: 'onboarding'; session: CreatedSession };

/** The operations of the ticket these tests drive, as described above. */
interface TicketOperations {
  signUp(input: SignUpInput): Promise<{ status: 'check_email'; ticket: string }>;
  confirm(token: string): Promise<{ status: 'confirmed' }>;
  confirmationStatus(
    ticket: string | undefined,
    currentSessionId?: string,
  ): Promise<ConfirmationStatus>;
}

const service = createAuthService({
  uow,
  auth,
  hmacSecret: HMAC_SECRET,
  webOrigin: WEB_ORIGIN,
}) as TicketOperations & AuthService;

const usedEmails = new Set<string>();

const hmacOf = (email: string) =>
  createHmac('sha256', HMAC_SECRET).update(email.trim().toLowerCase()).digest('hex');

const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');

const newHash = () => sha256(randomBytes(32).toString('base64url'));

const inHours = (hours: number) => new Date(Date.now() + hours * 60 * 60 * 1000);

function freshEmail(): string {
  const email = `${randomUUID()}@signup-ticket.test`;
  usedEmails.add(email);
  return email;
}

const signUp = (email: string, name = 'Ana Pérez') =>
  service.signUp({ name, email, password: PASSWORD, termsAccepted: true });

const tokenIn = (link: string | null): string => {
  const match = /[A-Za-z0-9_-]{43}/.exec(link ?? '');
  if (!match) throw new Error(`no token in link ${String(link)}`);
  return match[0];
};

async function latestLink(email: string, kind: 'confirm' | 'reset'): Promise<string> {
  const rows = await testPrisma().$queryRaw<{ link: string | null }[]>`
    SELECT payload->>'link' AS link FROM email_outbox
    WHERE to_address = ${email} AND kind = ${kind}::email_kind
    ORDER BY created_at DESC, id DESC LIMIT 1`;
  const row = rows[0];
  if (row === undefined) throw new Error(`no ${kind} email for ${email}`);
  return tokenIn(row.link);
}

async function userIdOf(email: string): Promise<string> {
  const rows = await testPrisma().$queryRaw<{ id: string }[]>`
    SELECT id::text AS id FROM auth_user WHERE email = ${email}`;
  const row = rows[0];
  if (row === undefined) throw new Error(`no user for ${email}`);
  return row.id;
}

async function verified(email: string): Promise<boolean> {
  const rows = await testPrisma().$queryRaw<{ verified: boolean }[]>`
    SELECT email_verified AS verified FROM auth_user WHERE email = ${email}`;
  return rows[0]?.verified ?? false;
}

async function sessionIdsOf(userId: string): Promise<string[]> {
  const rows = await testPrisma().$queryRaw<{ id: string }[]>`
    SELECT id::text AS id FROM auth_session WHERE user_id = ${userId}::uuid`;
  return rows.map((row) => row.id);
}

interface TicketRow {
  tokenHash: string;
  confirmed: boolean;
  expiresInSeconds: number;
}

async function ticketsOf(userId: string): Promise<TicketRow[]> {
  const rows = await testPrisma().$queryRaw<TicketRow[]>`
    SELECT token_hash AS "tokenHash", (confirmed_at IS NOT NULL) AS confirmed,
           extract(epoch FROM expires_at - now())::float AS "expiresInSeconds"
    FROM signup_ticket WHERE user_id = ${userId}::uuid`;
  return rows.map((row) => ({ ...row, tokenHash: row.tokenHash.trim() }));
}

async function ticketExists(tokenHash: string): Promise<boolean> {
  const rows = await testPrisma().$queryRaw<{ n: number }[]>`
    SELECT count(*)::int AS n FROM signup_ticket WHERE token_hash = ${tokenHash}`;
  return rows[0]?.n === 1;
}

async function expireTicket(ticket: string): Promise<void> {
  await testPrisma().$executeRaw`
    UPDATE signup_ticket SET expires_at = now() - interval '1 second'
    WHERE token_hash = ${sha256(ticket)}`;
}

/** Signs up a new email and returns the ticket of that registration. */
async function pendingAccount(): Promise<{ email: string; userId: string; ticket: string }> {
  const email = freshEmail();
  const { ticket } = await signUp(email);
  return { email, userId: await userIdOf(email), ticket };
}

const confirmed = (
  result: ConfirmationStatus,
): { status: 'confirmed'; next: 'onboarding'; session: CreatedSession } => {
  if (result.status !== 'confirmed') throw new Error('the ticket answered pending');
  return result;
};

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
  const db = testPrisma();
  await db.$executeRaw`DELETE FROM auth_user WHERE email = ANY(${emails}::text[])`;
  await db.$executeRaw`DELETE FROM email_outbox WHERE to_address = ANY(${emails}::text[])`;
  await db.$executeRaw`
    DELETE FROM email_send_log WHERE email_hmac = ANY(${emails.map(hmacOf)}::text[])`;
  await db.$executeRaw`
    DELETE FROM login_throttle WHERE email_hmac = ANY(${emails.map(hmacOf)}::text[])`;
  await deleteCreatedUsers();
  await disconnectTestPrisma();
});

describe('signup_ticket repository', () => {
  it('RF-M1-18 issue keeps the ticket, and claim does not deliver it before the confirmation', async () => {
    const user = await createUser();
    const hash = newHash();

    await uow.run((repos) => repos.signupTickets.issue(user.id, hash, inHours(24)));
    const claimed = await uow.run((repos) => repos.signupTickets.claim(hash));

    expect(claimed).toBeNull();
    expect(await ticketExists(hash)).toBe(true);
  });

  it('RF-M1-18 once marked confirmed, claim delivers the user a single time', async () => {
    const user = await createUser();
    const hash = newHash();
    await uow.run((repos) => repos.signupTickets.issue(user.id, hash, inHours(24)));
    await uow.run((repos) => repos.signupTickets.markConfirmed(user.id));

    const first = await uow.run((repos) => repos.signupTickets.claim(hash));
    const second = await uow.run((repos) => repos.signupTickets.claim(hash));

    expect(first).toBe(user.id);
    expect(second).toBeNull();
    expect(await ticketExists(hash)).toBe(false);
  });

  it('RF-M1-18 two simultaneous claims of the same ticket deliver it only once', async () => {
    const user = await createUser();
    const hash = newHash();
    await uow.run((repos) => repos.signupTickets.issue(user.id, hash, inHours(24)));
    await uow.run((repos) => repos.signupTickets.markConfirmed(user.id));

    const results = await Promise.all([
      uow.run((repos) => repos.signupTickets.claim(hash)),
      uow.run((repos) => repos.signupTickets.claim(hash)),
    ]);

    expect(results.filter((id) => id === user.id)).toHaveLength(1);
    expect(results.filter((id) => id === null)).toHaveLength(1);
  });

  it('RF-M1-18 claim does not deliver a confirmed ticket that has expired', async () => {
    const user = await createUser();
    const hash = newHash();
    await uow.run((repos) => repos.signupTickets.issue(user.id, hash, inHours(-1)));
    await uow.run((repos) => repos.signupTickets.markConfirmed(user.id));

    expect(await uow.run((repos) => repos.signupTickets.claim(hash))).toBeNull();
  });

  it('RF-M1-18 claim with an unknown hash resolves null', async () => {
    expect(await uow.run((repos) => repos.signupTickets.claim(newHash()))).toBeNull();
  });

  it('EC-M1-14 issue replaces the previous ticket of the user', async () => {
    const user = await createUser();
    const old = newHash();
    const fresh = newHash();
    await uow.run((repos) => repos.signupTickets.issue(user.id, old, inHours(24)));

    await uow.run((repos) => repos.signupTickets.issue(user.id, fresh, inHours(24)));
    await uow.run((repos) => repos.signupTickets.markConfirmed(user.id));

    expect(await ticketExists(old)).toBe(false);
    expect(await uow.run((repos) => repos.signupTickets.claim(old))).toBeNull();
    expect(await uow.run((repos) => repos.signupTickets.claim(fresh))).toBe(user.id);
  });

  it('EC-M1-14 deleteForUser deletes the ticket of that user and no other', async () => {
    const user = await createUser();
    const other = await createUser();
    const mine = newHash();
    const theirs = newHash();
    await uow.run((repos) => repos.signupTickets.issue(user.id, mine, inHours(24)));
    await uow.run((repos) => repos.signupTickets.issue(other.id, theirs, inHours(24)));

    await uow.run((repos) => repos.signupTickets.deleteForUser(user.id));

    expect(await ticketExists(mine)).toBe(false);
    expect(await ticketExists(theirs)).toBe(true);
  });

  it('RF-M1-18 markConfirmed only marks the ticket of that user', async () => {
    const user = await createUser();
    const other = await createUser();
    const theirs = newHash();
    await uow.run((repos) => repos.signupTickets.issue(other.id, theirs, inHours(24)));

    await uow.run((repos) => repos.signupTickets.markConfirmed(user.id));

    expect(await uow.run((repos) => repos.signupTickets.claim(theirs))).toBeNull();
    expect(await ticketExists(theirs)).toBe(true);
  });

  it('RF-M1-18 purgeExpired deletes the expired tickets and keeps the current ones', async () => {
    const expiredUser = await createUser();
    const currentUser = await createUser();
    const expired = newHash();
    const current = newHash();
    await uow.run((repos) => repos.signupTickets.issue(expiredUser.id, expired, inHours(-1)));
    await uow.run((repos) => repos.signupTickets.issue(currentUser.id, current, inHours(1)));

    await uow.run((repos) => repos.signupTickets.purgeExpired(new Date()));

    expect(await ticketExists(expired)).toBe(false);
    expect(await ticketExists(current)).toBe(true);
  });
});

describe('sign-up: the ticket', () => {
  it('RF-M1-18 the sign-up of a new email keeps only the SHA-256 of its ticket, for 24 hours', async () => {
    const { userId, ticket } = await pendingAccount();

    expect(ticket).toMatch(TICKET);
    const tickets = await ticketsOf(userId);
    expect(tickets).toHaveLength(1);
    expect(tickets[0]?.tokenHash).toBe(sha256(ticket));
    expect(tickets[0]?.tokenHash).not.toBe(ticket);
    expect(tickets[0]?.confirmed).toBe(false);
    expect(tickets[0]?.expiresInSeconds).toBeGreaterThan(DAY_SECONDS - 120);
    expect(tickets[0]?.expiresInSeconds).toBeLessThanOrEqual(DAY_SECONDS + 5);
  });

  it('RNF-15 registrarse con un correo nuevo, uno Sin confirmar y uno Activo responde lo mismo y entrega un ticket en los tres casos', async () => {
    const owner = await createUser();
    usedEmails.add(owner.email);
    const pending = await pendingAccount();

    const forNew = await signUp(freshEmail());
    const forPending = await signUp(pending.email);
    const forActive = await signUp(owner.email);

    for (const result of [forNew, forPending, forActive]) {
      expect(Object.keys(result).sort()).toEqual(['status', 'ticket']);
      expect(result.status).toBe('check_email');
      expect(result.ticket).toMatch(TICKET);
    }
    expect(new Set([forNew.ticket, forPending.ticket, forActive.ticket]).size).toBe(3);
  });

  it('RNF-15 the sign-up with an Active email keeps no ticket for that account', async () => {
    const owner = await createUser();
    usedEmails.add(owner.email);

    const { ticket } = await signUp(owner.email);

    expect(await ticketsOf(owner.id)).toEqual([]);
    expect(await ticketExists(sha256(ticket))).toBe(false);
  });

  it('RNF-15 con el ticket del correo Activo confirmationStatus responde pending siempre', async () => {
    const owner = await createUser();
    usedEmails.add(owner.email);
    const { ticket } = await signUp(owner.email);

    const first = await service.confirmationStatus(ticket);
    const second = await service.confirmationStatus(ticket);

    expect(first).toEqual({ status: 'pending' });
    expect(second).toEqual({ status: 'pending' });
    expect(await sessionIdsOf(owner.id)).toEqual([]);
  });

  it('RNF-15 the ticket of an Active email answers like an unknown ticket', async () => {
    const owner = await createUser();
    usedEmails.add(owner.email);
    const { ticket } = await signUp(owner.email);

    const forActive = await service.confirmationStatus(ticket);
    const forUnknown = await service.confirmationStatus(randomBytes(32).toString('base64url'));

    expect(forActive).toEqual(forUnknown);
  });
});

describe('confirmationStatus', () => {
  it('RF-M1-18 La pestaña de registro continúa sola al confirmar el correo: pending antes del enlace y confirmed con la sesión después', async () => {
    const { email, userId, ticket } = await pendingAccount();

    const before = await service.confirmationStatus(ticket);
    const link = await service.confirm(await latestLink(email, 'confirm'));
    const after = await service.confirmationStatus(ticket);

    expect(before).toEqual({ status: 'pending' });
    expect(link).toEqual({ status: 'confirmed' });
    expect(after).toMatchObject({ status: 'confirmed', next: 'onboarding' });
    const { session } = confirmed(after);
    expect(await sessionIdsOf(userId)).toEqual([session.sessionId]);
    expect((await auth.getSession(session.token))?.userId).toBe(userId);
    expect(session.cookie).toMatch(/HttpOnly/i);
  });

  it('RF-M1-18 confirm deja el correo verificado y no crea ninguna sesión: solo el ticket la abre', async () => {
    const { email, userId } = await pendingAccount();

    await service.confirm(await latestLink(email, 'confirm'));

    expect(await verified(email)).toBe(true);
    expect(await sessionIdsOf(userId)).toEqual([]);
    expect((await ticketsOf(userId))[0]?.confirmed).toBe(true);
  });

  it('RF-M1-18 el ticket sirve una sola vez: la segunda llamada responde pending', async () => {
    const { email, userId, ticket } = await pendingAccount();
    await service.confirm(await latestLink(email, 'confirm'));
    const first = confirmed(await service.confirmationStatus(ticket));

    const second = await service.confirmationStatus(ticket);

    expect(second).toEqual({ status: 'pending' });
    expect(await sessionIdsOf(userId)).toEqual([first.session.sessionId]);
    expect(await ticketsOf(userId)).toEqual([]);
  });

  it('RF-M1-18 two simultaneous calls with the same ticket open a single session', async () => {
    const { email, userId, ticket } = await pendingAccount();
    await service.confirm(await latestLink(email, 'confirm'));

    const results = await Promise.all([
      service.confirmationStatus(ticket),
      service.confirmationStatus(ticket),
    ]);

    expect(results.filter((r) => r.status === 'confirmed')).toHaveLength(1);
    expect(results.filter((r) => r.status === 'pending')).toHaveLength(1);
    expect(await sessionIdsOf(userId)).toHaveLength(1);
  });

  it('RF-M1-18 without a ticket the answer is pending', async () => {
    expect(await service.confirmationStatus(undefined)).toEqual({ status: 'pending' });
  });

  it('RF-M1-18 an unknown ticket answers pending', async () => {
    const result = await service.confirmationStatus(randomBytes(32).toString('base64url'));

    expect(result).toEqual({ status: 'pending' });
  });

  it('RF-M1-18 the ticket of another registration does not open the session of this one', async () => {
    const first = await pendingAccount();
    const second = await pendingAccount();
    await service.confirm(await latestLink(first.email, 'confirm'));

    expect(await service.confirmationStatus(second.ticket)).toEqual({ status: 'pending' });
    expect(await sessionIdsOf(first.userId)).toEqual([]);
    expect(await sessionIdsOf(second.userId)).toEqual([]);
  });

  it('RF-M1-18 un ticket vencido (más de 24 h) responde pending aunque se abra el enlace', async () => {
    const { email, userId, ticket } = await pendingAccount();
    await expireTicket(ticket);
    await service.confirm(await latestLink(email, 'confirm'));

    const result = await service.confirmationStatus(ticket);

    expect(result).toEqual({ status: 'pending' });
    expect(await sessionIdsOf(userId)).toEqual([]);
    expect(await verified(email)).toBe(true);
  });

  it('EC-M1-14 EC-M1-09 registrarse de nuevo con el correo invalida el ticket anterior: aunque se abra el enlace nuevo, el ticket viejo responde pending', async () => {
    const { email, userId, ticket: old } = await pendingAccount();
    const { ticket: fresh } = await signUp(email, 'Ana María');

    await service.confirm(await latestLink(email, 'confirm'));

    expect(await service.confirmationStatus(old)).toEqual({ status: 'pending' });
    expect(await sessionIdsOf(userId)).toEqual([]);
    const opened = confirmed(await service.confirmationStatus(fresh));
    expect(await sessionIdsOf(userId)).toEqual([opened.session.sessionId]);
  });

  it('EC-M1-14 EC-M1-09 the new registration keeps a single ticket, the one of the new sign-up', async () => {
    const { email, userId } = await pendingAccount();

    const { ticket: fresh } = await signUp(email);

    const tickets = await ticketsOf(userId);
    expect(tickets).toHaveLength(1);
    expect(tickets[0]?.tokenHash).toBe(sha256(fresh));
  });

  it('EC-M1-14 EC-M1-10 recuperar la contraseña de una cuenta Sin confirmar invalida el ticket del registro', async () => {
    const { email, userId, ticket } = await pendingAccount();
    await service.forgotPassword({ email });

    const reset = await service.resetPassword({
      token: await latestLink(email, 'reset'),
      newPassword: NEW_PASSWORD,
    });

    expect(await service.confirmationStatus(ticket)).toEqual({ status: 'pending' });
    expect(await sessionIdsOf(userId)).toEqual([reset.session.sessionId]);
    expect(await ticketsOf(userId)).toEqual([]);
  });

  it('EC-M1-11 si el navegador del ticket tiene la sesión de otro usuario, confirmationStatus la cierra y abre la del usuario confirmado', async () => {
    const { email, userId, ticket } = await pendingAccount();
    const other = await createUser();
    const deviceSession = await auth.createSession(other.id);
    await service.confirm(await latestLink(email, 'confirm'));

    const result = confirmed(await service.confirmationStatus(ticket, deviceSession.sessionId));

    expect(await auth.getSession(deviceSession.token)).toBeNull();
    expect(await sessionIdsOf(other.id)).not.toContain(deviceSession.sessionId);
    expect(await sessionIdsOf(userId)).toEqual([result.session.sessionId]);
    expect((await auth.getSession(result.session.token))?.userId).toBe(userId);
  });

  it('EC-M1-11 only the session of the other user on that browser is closed, not its other devices', async () => {
    const { email, ticket } = await pendingAccount();
    const other = await createUser();
    const deviceSession = await auth.createSession(other.id);
    const elsewhere = await auth.createSession(other.id);
    await service.confirm(await latestLink(email, 'confirm'));

    await service.confirmationStatus(ticket, deviceSession.sessionId);

    expect(await sessionIdsOf(other.id)).toEqual([elsewhere.sessionId]);
    expect((await auth.getSession(elsewhere.token))?.userId).toBe(other.id);
  });

  it('EC-M1-11 while the ticket is pending the session of the other user stays open', async () => {
    const { ticket } = await pendingAccount();
    const other = await createUser();
    const deviceSession = await auth.createSession(other.id);

    const result = await service.confirmationStatus(ticket, deviceSession.sessionId);

    expect(result).toEqual({ status: 'pending' });
    expect((await auth.getSession(deviceSession.token))?.userId).toBe(other.id);
  });

  it('RF-M1-04 una cuenta sin confirmar sigue sin sesión, con o sin ticket', async () => {
    const { email, userId, ticket } = await pendingAccount();

    expect(await service.confirmationStatus(ticket)).toEqual({ status: 'pending' });
    expect(await service.confirmationStatus(undefined)).toEqual({ status: 'pending' });
    const error = await rejectionOf(service.signIn({ email, password: PASSWORD }));

    expect(error.code).toBe('EMAIL_NOT_CONFIRMED');
    expect(await sessionIdsOf(userId)).toEqual([]);
    expect(await verified(email)).toBe(false);
  });
});
