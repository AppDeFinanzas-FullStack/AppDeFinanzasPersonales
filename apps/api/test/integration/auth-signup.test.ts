import { createHash, createHmac, randomUUID } from 'node:crypto';

import { afterAll, describe, expect, it } from 'vitest';

import { createAuthService } from '../../src/application/services/auth.service.js';
import { createBetterAuthGateway } from '../../src/infrastructure/auth/better-auth.js';
import { createEmailLinkRepository } from '../../src/infrastructure/persistence/repositories/email-link.repository.js';
import { createEmailOutboxRepository } from '../../src/infrastructure/persistence/repositories/email-outbox.repository.js';
import { createLoginThrottleRepository } from '../../src/infrastructure/persistence/repositories/login-throttle.repository.js';
import { createUserRepository } from '../../src/infrastructure/persistence/repositories/user.repository.js';
import { createUnitOfWork } from '../../src/infrastructure/persistence/unit-of-work.js';
import { createUser, deleteCreatedUsers } from '../factories/user.factory.js';
import { disconnectTestPrisma, testPrisma } from './setup/db.js';

/**
 * The plan fixes `POST /api/auth/sign-up` (§4.1.2) and its concurrency rules (§4.1.3), but not the
 * names of the pieces. These tests use:
 * - `createAuthService({ uow, auth, hmacSecret, webOrigin })` with `signUp({ name, email, password,
 *   termsAccepted })`, which always resolves `{ status: 'check_email' }`;
 * - the repositories `emailOutbox`, `emailLinks`, `loginThrottle` and `users` over one `UnitOfWork`
 *   (`users` also holds `findByEmail`, `createUnconfirmed`, `replaceUnconfirmed` and
 *   `claimRegisterAttempt`);
 * - the real Better Auth gateway over the test database.
 * The service normalizes the email (trim + lowercase). The key of `email_send_log` is the lowercase
 * hex HMAC-SHA256 of the normalized email under `hmacSecret`. Time is the database's: tests move it
 * by editing the rows.
 */
const HMAC_SECRET = 'hmac-secret-for-the-sign-up-test';
const WEB_ORIGIN = 'https://app.finanzas.test';
const PASSWORD = 'Clave-segura-123';

const auth = createBetterAuthGateway({
  prisma: testPrisma(),
  secret: 'test-secret-test-secret-test-secret-0123',
});
const uow = createUnitOfWork(testPrisma(), (tx) => ({
  emailOutbox: createEmailOutboxRepository(tx),
  emailLinks: createEmailLinkRepository(tx),
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

const freshEmail = () => {
  const email = `${randomUUID()}@signup.test`;
  usedEmails.add(email);
  return email;
};

const hmacOf = (email: string) =>
  createHmac('sha256', HMAC_SECRET).update(email.toLowerCase()).digest('hex');

const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');

const signUp = (email: string, overrides: { name?: string; password?: string } = {}) =>
  service.signUp({
    name: overrides.name ?? 'Ana Pérez',
    email,
    password: overrides.password ?? PASSWORD,
    termsAccepted: true,
  });

interface UserRow {
  id: string;
  name: string;
  email: string;
  verified: boolean;
  termsAccepted: boolean;
  registeredAgoSeconds: number;
}

async function usersOf(email: string): Promise<UserRow[]> {
  return testPrisma().$queryRaw<UserRow[]>`
    SELECT id::text AS id, name, email, email_verified AS verified,
           (terms_accepted_at IS NOT NULL) AS "termsAccepted",
           extract(epoch FROM now() - registered_at)::float AS "registeredAgoSeconds"
    FROM auth_user WHERE email = ${email.trim().toLowerCase()}`;
}

async function onlyUser(email: string): Promise<UserRow> {
  const rows = await usersOf(email);
  expect(rows).toHaveLength(1);
  return rows[0] as UserRow;
}

async function passwordHashOf(userId: string): Promise<string | null> {
  const rows = await testPrisma().$queryRaw<{ password: string | null }[]>`
    SELECT password FROM auth_account
    WHERE user_id = ${userId}::uuid AND provider_id = 'credential'`;
  return rows[0]?.password ?? null;
}

interface LinkRow {
  tokenHash: string;
  invalidated: boolean;
  used: boolean;
  lifetimeSeconds: number;
}

async function linksOf(userId: string): Promise<LinkRow[]> {
  return testPrisma().$queryRaw<LinkRow[]>`
    SELECT token_hash AS "tokenHash", (invalidated_at IS NOT NULL) AS invalidated,
           (used_at IS NOT NULL) AS used,
           extract(epoch FROM expires_at - created_at)::int AS "lifetimeSeconds"
    FROM email_link
    WHERE user_id = ${userId}::uuid AND purpose = 'confirm_email'::email_link_purpose
    ORDER BY created_at, id`;
}

interface OutboxRow {
  to: string;
  kind: string;
  link: string | null;
}

async function outboxOf(email: string, kind?: string): Promise<OutboxRow[]> {
  const rows = await testPrisma().$queryRaw<OutboxRow[]>`
    SELECT to_address AS "to", kind::text AS kind, payload->>'link' AS link
    FROM email_outbox WHERE to_address = ${email.trim().toLowerCase()}
    ORDER BY created_at, id`;
  return kind === undefined ? rows : rows.filter((row) => row.kind === kind);
}

const tokenIn = (link: string | null): string => {
  const match = /[A-Za-z0-9_-]{43}/.exec(link ?? '');
  if (!match) throw new Error(`no token in link ${String(link)}`);
  return match[0];
};

async function sendLogCount(email: string): Promise<number> {
  const rows = await testPrisma().$queryRaw<{ n: number }[]>`
    SELECT count(*)::int AS n FROM email_send_log
    WHERE email_hmac = ${hmacOf(email)} AND kind = 'register_attempt'::email_kind`;
  return rows[0]?.n ?? 0;
}

async function backdateSendLog(email: string, interval: string): Promise<void> {
  await testPrisma().$executeRawUnsafe(
    `UPDATE email_send_log SET sent_at = now() - interval '${interval}' WHERE email_hmac = $1`,
    hmacOf(email),
  );
}

async function backdateRegistration(email: string, interval: string): Promise<void> {
  await testPrisma().$executeRawUnsafe(
    `UPDATE auth_user SET registered_at = now() - interval '${interval}' WHERE email = $1`,
    email.toLowerCase(),
  );
}

/** Creates an Active (confirmed) account whose email is the given one. */
async function activeAccount() {
  const user = await createUser();
  usedEmails.add(user.email);
  return user;
}

afterAll(async () => {
  const emails = [...usedEmails];
  await testPrisma().$executeRaw`DELETE FROM auth_user WHERE email = ANY(${emails}::text[])`;
  await testPrisma().$executeRaw`DELETE FROM email_outbox WHERE to_address = ANY(${emails}::text[])`;
  await testPrisma().$executeRaw`
    DELETE FROM email_send_log WHERE email_hmac = ANY(${emails.map(hmacOf)}::text[])`;
  await deleteCreatedUsers();
  await disconnectTestPrisma();
});

describe('sign-up: new email', () => {
  it('RF-M1-01 a new email creates an unconfirmed user with its name, normalized email and accepted terms', async () => {
    const email = freshEmail();

    await service.signUp({
      name: 'Ana Pérez',
      email: `  ${email.toUpperCase()} `,
      password: PASSWORD,
      termsAccepted: true,
    });

    const user = await onlyUser(email);
    expect(user).toMatchObject({
      name: 'Ana Pérez',
      email,
      verified: false,
      termsAccepted: true,
    });
    expect(user.registeredAgoSeconds).toBeLessThan(30);
  });

  it('RF-M1-01 the password is stored only as a hash the gateway verifies', async () => {
    const email = freshEmail();
    await signUp(email);

    const user = await onlyUser(email);
    const hash = await passwordHashOf(user.id);

    expect(hash).not.toBeNull();
    expect(hash).not.toContain(PASSWORD);
    expect(await auth.verifyPassword(hash as string, PASSWORD)).toBe(true);
  });

  it('RF-M1-03 a new email gets the neutral response', async () => {
    const result = await signUp(freshEmail());

    expect(result).toEqual({ status: 'check_email' });
  });

  it('RF-M1-01 a new user gets the initial data of any user', async () => {
    const email = freshEmail();
    await signUp(email);
    const user = await onlyUser(email);

    const rows = await testPrisma().$queryRaw<
      { currencies: number; settings: number; categories: number; preferences: number }[]
    >`
      SELECT (SELECT count(*) FROM currency WHERE user_id = ${user.id}::uuid)::int AS currencies,
             (SELECT count(*) FROM user_settings WHERE user_id = ${user.id}::uuid)::int AS settings,
             (SELECT count(*) FROM category WHERE user_id = ${user.id}::uuid)::int AS categories,
             (SELECT count(*) FROM notification_preference
              WHERE user_id = ${user.id}::uuid)::int AS preferences`;
    expect(rows[0]?.currencies).toBe(2);
    expect(rows[0]?.settings).toBe(1);
    expect(rows[0]?.categories).toBeGreaterThan(0);
    expect(rows[0]?.preferences).toBe(6);
  });

  it('RF-M1-01 a 24 hour confirmation link is created and sent in a confirm email', async () => {
    const email = freshEmail();
    await signUp(email);
    const user = await onlyUser(email);

    const links = await linksOf(user.id);
    expect(links).toHaveLength(1);
    expect(links[0]).toMatchObject({ invalidated: false, used: false, lifetimeSeconds: 24 * 3600 });
    const confirms = await outboxOf(email, 'confirm');
    expect(confirms).toHaveLength(1);
    expect(confirms[0]?.link?.startsWith(WEB_ORIGIN)).toBe(true);
    expect(sha256(tokenIn(confirms[0]?.link ?? null))).toBe(links[0]?.tokenHash.trim());
    expect(await outboxOf(email, 'register_attempt')).toHaveLength(0);
  });
});

describe('sign-up: existing active account', () => {
  it('RNF-15 a registration with an existing email does not reveal the account: same response, one account', async () => {
    const owner = await activeAccount();
    const before = await onlyUser(owner.email);

    const result = await service.signUp({
      name: 'Intruso',
      email: `${owner.email.toUpperCase()} `,
      password: 'Otra-clave-456',
      termsAccepted: true,
    });

    expect(result).toEqual({ status: 'check_email' });
    const after = await onlyUser(owner.email);
    expect(after).toMatchObject({ id: before.id, name: before.name, verified: true });
    expect(await passwordHashOf(owner.id)).toBeNull();
    expect(await outboxOf(owner.email, 'confirm')).toHaveLength(0);
    expect(await linksOf(owner.id)).toHaveLength(0);
  });

  it('RF-M1-03 Registro con correo ya existente no revela la cuenta: the owner gets a register_attempt notice', async () => {
    const owner = await activeAccount();

    await service.signUp({
      name: 'Ana',
      email: `${owner.email.toUpperCase()} `,
      password: PASSWORD,
      termsAccepted: true,
    });

    const notices = await outboxOf(owner.email, 'register_attempt');
    expect(notices).toHaveLength(1);
    expect(notices[0]?.to).toBe(owner.email);
    expect(await usersOf(owner.email)).toHaveLength(1);
  });

  it('RF-M1-17 two attempts within 1 hour enqueue a single notice', async () => {
    const owner = await activeAccount();

    const first = await signUp(owner.email);
    const second = await signUp(owner.email.toUpperCase());

    expect(first).toEqual({ status: 'check_email' });
    expect(second).toEqual({ status: 'check_email' });
    expect(await outboxOf(owner.email, 'register_attempt')).toHaveLength(1);
    expect(await sendLogCount(owner.email)).toBe(1);
  });

  it('RF-M1-17 the limit is keyed by the HMAC of the email, which is never stored in clear', async () => {
    const owner = await activeAccount();
    await signUp(owner.email);

    expect(await sendLogCount(owner.email)).toBe(1);
    const leaked = await testPrisma().$queryRaw<{ n: number }[]>`
      SELECT count(*)::int AS n FROM email_send_log WHERE email_hmac LIKE ${'%test.local%'}`;
    expect(leaked[0]?.n).toBe(0);
  });

  it('RF-M1-17 59 minutes after the last notice a new attempt still sends nothing', async () => {
    const owner = await activeAccount();
    await signUp(owner.email);
    await backdateSendLog(owner.email, '59 minutes');

    await signUp(owner.email);

    expect(await outboxOf(owner.email, 'register_attempt')).toHaveLength(1);
  });

  it('RF-M1-17 after 1 hour a new attempt sends another notice', async () => {
    const owner = await activeAccount();
    await signUp(owner.email);
    await backdateSendLog(owner.email, '61 minutes');

    await signUp(owner.email);

    expect(await outboxOf(owner.email, 'register_attempt')).toHaveLength(2);
  });

  it('RF-M1-17 simultaneous attempts enqueue a single notice', async () => {
    const owner = await activeAccount();

    await Promise.all([signUp(owner.email), signUp(owner.email), signUp(owner.email)]);

    expect(await outboxOf(owner.email, 'register_attempt')).toHaveLength(1);
  });

  it('RF-M1-17 the limit is per account: another account is notified', async () => {
    const first = await activeAccount();
    const second = await activeAccount();

    await signUp(first.email);
    await signUp(second.email);

    expect(await outboxOf(first.email, 'register_attempt')).toHaveLength(1);
    expect(await outboxOf(second.email, 'register_attempt')).toHaveLength(1);
  });
});

describe('sign-up: unconfirmed registration', () => {
  it('EC-M1-09 a repeated registration replaces the name and the password of the same user', async () => {
    const email = freshEmail();
    await signUp(email, { name: 'Nombre viejo', password: 'Clave-vieja-111' });
    const before = await onlyUser(email);

    await signUp(email, { name: 'Nombre nuevo', password: 'Clave-nueva-222' });

    const after = await onlyUser(email);
    expect(after.id).toBe(before.id);
    expect(after.name).toBe('Nombre nuevo');
    expect(after.verified).toBe(false);
    const hash = await passwordHashOf(after.id);
    expect(await auth.verifyPassword(hash as string, 'Clave-nueva-222')).toBe(true);
    expect(await auth.verifyPassword(hash as string, 'Clave-vieja-111')).toBe(false);
  });

  it('EC-M1-09 the previous link is invalidated and a new one is sent', async () => {
    const email = freshEmail();
    await signUp(email);
    const user = await onlyUser(email);

    await signUp(email);

    const links = await linksOf(user.id);
    expect(links).toHaveLength(2);
    expect(links.filter((link) => !link.invalidated && !link.used)).toHaveLength(1);
    const confirms = await outboxOf(email, 'confirm');
    expect(confirms).toHaveLength(2);
    const [oldLink, newLink] = confirms.map((row) => sha256(tokenIn(row.link)));
    const active = links.find((link) => !link.invalidated);
    expect(active?.tokenHash.trim()).toBe(newLink);
    expect(links.find((link) => link.invalidated)?.tokenHash.trim()).toBe(oldLink);
    expect(await outboxOf(email, 'register_attempt')).toHaveLength(0);
  });

  it('RF-M1-06 a repeated registration restarts the 7 day period', async () => {
    const email = freshEmail();
    await signUp(email);
    await backdateRegistration(email, '6 days');
    expect((await onlyUser(email)).registeredAgoSeconds).toBeGreaterThan(5 * 24 * 3600);

    await signUp(email);

    expect((await onlyUser(email)).registeredAgoSeconds).toBeLessThan(60);
  });

  it('EC-M1-09 the response for an unconfirmed email is the neutral one', async () => {
    const email = freshEmail();
    await signUp(email);

    expect(await signUp(email)).toEqual({ status: 'check_email' });
  });

  it('EC-M1-03 a registration discarded after 7 days is treated as a new registration', async () => {
    const email = freshEmail();
    await signUp(email, { name: 'Primero' });
    const first = await onlyUser(email);
    await backdateRegistration(email, '8 days');
    await testPrisma().$executeRaw`
      DELETE FROM auth_user WHERE NOT email_verified AND registered_at < now() - interval '7 days'
        AND email = ${email}`;
    expect(await usersOf(email)).toHaveLength(0);

    const result = await signUp(email, { name: 'Segundo' });

    expect(result).toEqual({ status: 'check_email' });
    const second = await onlyUser(email);
    expect(second.id).not.toBe(first.id);
    expect(second).toMatchObject({ name: 'Segundo', verified: false });
    expect(await linksOf(second.id)).toHaveLength(1);
    expect(await outboxOf(email, 'confirm')).toHaveLength(2);
  });

  it('EC-M1-09 two simultaneous registrations of the same email leave one user and one active link', async () => {
    const email = freshEmail();

    const results = await Promise.all([signUp(email), signUp(email)]);

    expect(results).toEqual([{ status: 'check_email' }, { status: 'check_email' }]);
    const user = await onlyUser(email);
    const links = await linksOf(user.id);
    expect(links.filter((link) => !link.invalidated && !link.used)).toHaveLength(1);
    expect(await passwordHashOf(user.id)).not.toBeNull();
  });
});

describe('sign-up: neutral response', () => {
  it('RF-M1-03 the response is identical for a new, an unconfirmed and an active email', async () => {
    const owner = await activeAccount();
    const pending = freshEmail();
    await signUp(pending);

    const forNew = await signUp(freshEmail());
    const forPending = await signUp(pending);
    const forActive = await signUp(owner.email);

    expect(forNew).toEqual({ status: 'check_email' });
    expect(forPending).toEqual(forNew);
    expect(forActive).toEqual(forNew);
    expect(JSON.stringify(forActive)).toBe(JSON.stringify(forNew));
  });

  it('RNF-15 the response time does not tell the three cases apart', async () => {
    const owner = await activeAccount();
    const pending = freshEmail();
    await signUp(pending);
    const average = async (run: () => Promise<unknown>) => {
      const times: number[] = [];
      for (let i = 0; i < 3; i += 1) {
        const start = performance.now();
        await run();
        times.push(performance.now() - start);
      }
      return times.reduce((sum, ms) => sum + ms, 0) / times.length;
    };

    const forNew = await average(() => signUp(freshEmail()));
    const forPending = await average(() => signUp(pending));
    const forActive = await average(async () => {
      await backdateSendLog(owner.email, '2 hours');
      return signUp(owner.email);
    });

    const all = [forNew, forPending, forActive];
    expect(Math.max(...all) - Math.min(...all)).toBeLessThan(300);
  });
});
