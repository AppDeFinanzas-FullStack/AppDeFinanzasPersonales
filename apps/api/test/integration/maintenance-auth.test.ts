import { randomUUID } from 'node:crypto';

import { afterAll, describe, expect, it } from 'vitest';

import { createMaintenance } from '../../src/application/jobs/maintenance.js';
import type { Clock } from '../../src/application/ports/clock.js';
import { createAuthService } from '../../src/application/services/auth.service.js';
import { createBetterAuthGateway } from '../../src/infrastructure/auth/better-auth.js';
import { createMaintenanceStore } from '../../src/infrastructure/persistence/maintenance-store.js';
import { createEmailLinkRepository } from '../../src/infrastructure/persistence/repositories/email-link.repository.js';
import { createEmailOutboxRepository } from '../../src/infrastructure/persistence/repositories/email-outbox.repository.js';
import { createLoginThrottleRepository } from '../../src/infrastructure/persistence/repositories/login-throttle.repository.js';
import { createUserRepository } from '../../src/infrastructure/persistence/repositories/user.repository.js';
import { createUnitOfWork } from '../../src/infrastructure/persistence/unit-of-work.js';
import { disconnectTestPrisma, testPrisma } from './setup/db.js';

/**
 * The plan fixes the `maintenance` job and its deletions (§4.1.3, §3.9) but not the names of the
 * pieces. These tests use:
 * - `createMaintenanceStore(prisma)`: the Prisma implementation of the `MaintenanceStore` port;
 * - `createMaintenance({ store, clock })`: the `maintenance` job, a `JobHandler`
 *   (`() => Promise<void>`). It deletes the unconfirmed `auth_user` rows whose `registered_at` is
 *   more than 7 days before `clock.now()`, the `email_send_log` rows older than 24 h and the
 *   `login_throttle` rows whose last activity (`last_failure_at`) is more than 1 h old.
 * Rows are placed in the past relative to the real time, which is also the job's clock.
 */
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

const clock: Clock = {
  now: () => new Date(),
  todayFor: () => new Date().toISOString().slice(0, 10),
};

const runMaintenance = createMaintenance({
  store: createMaintenanceStore(testPrisma()),
  clock,
});

const HMAC_SECRET = 'hmac-secret-for-the-maintenance-test';
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
  webOrigin: 'https://app.finanzas.test',
});

const userIds: string[] = [];
const hmacs: string[] = [];

const db = () => testPrisma();
const ago = (ms: number) => new Date(Date.now() - ms);

async function insertUser(options: { verified: boolean; registeredAgo: number }) {
  const id = randomUUID();
  const email = `${id}@maintenance.test`;
  await db().$executeRaw`
    INSERT INTO auth_user (id, name, email, email_verified, timezone, terms_accepted_at, registered_at)
    VALUES (${id}::uuid, 'Usuario', ${email}, ${options.verified}, 'America/La_Paz', now(),
            ${ago(options.registeredAgo)})`;
  userIds.push(id);
  return { id, email };
}

async function userExists(id: string): Promise<boolean> {
  const rows = await db().$queryRaw<{ id: string }[]>`
    SELECT id::text AS id FROM auth_user WHERE id = ${id}::uuid`;
  return rows.length === 1;
}

const newHmac = () => {
  const value = randomUUID().replaceAll('-', '') + randomUUID().replaceAll('-', '');
  hmacs.push(value);
  return value;
};

async function insertSendLog(sentAgo: number): Promise<string> {
  const hmac = newHmac();
  await db().$executeRaw`
    INSERT INTO email_send_log (email_hmac, kind, sent_at)
    VALUES (${hmac}, 'confirm', ${ago(sentAgo)})`;
  return hmac;
}

async function sendLogExists(hmac: string): Promise<boolean> {
  const rows = await db().$queryRaw<{ n: number }[]>`
    SELECT count(*)::int AS n FROM email_send_log WHERE email_hmac = ${hmac}`;
  return rows[0]?.n === 1;
}

async function insertThrottle(lastFailureAgo: number): Promise<string> {
  const hmac = newHmac();
  await db().$executeRaw`
    INSERT INTO login_throttle (email_hmac, consecutive_failures, last_failure_at)
    VALUES (${hmac}, 3, ${ago(lastFailureAgo)})`;
  return hmac;
}

async function throttleExists(hmac: string): Promise<boolean> {
  const rows = await db().$queryRaw<{ n: number }[]>`
    SELECT count(*)::int AS n FROM login_throttle WHERE email_hmac = ${hmac}`;
  return rows[0]?.n === 1;
}

afterAll(async () => {
  if (userIds.length > 0) {
    await db().$executeRaw`DELETE FROM auth_user WHERE id = ANY(${userIds}::uuid[])`;
  }
  if (hmacs.length > 0) {
    await db().$executeRaw`DELETE FROM email_send_log WHERE email_hmac = ANY(${hmacs})`;
    await db().$executeRaw`DELETE FROM login_throttle WHERE email_hmac = ANY(${hmacs})`;
  }
  await disconnectTestPrisma();
});

describe('maintenance: descarte de registros sin confirmar', () => {
  it('RF-M1-06 un usuario sin confirmar de hace 7 días y 1 minuto se borra', async () => {
    const stale = await insertUser({ verified: false, registeredAgo: 7 * DAY + MINUTE });
    await runMaintenance();
    expect(await userExists(stale.id)).toBe(false);
  });

  it('RF-M1-06 un usuario sin confirmar de hace 6 días no se borra', async () => {
    const recent = await insertUser({ verified: false, registeredAgo: 6 * DAY });
    await runMaintenance();
    expect(await userExists(recent.id)).toBe(true);
  });

  it('RF-M1-06 un usuario confirmado de hace más de 7 días no se borra', async () => {
    const confirmed = await insertUser({ verified: true, registeredAgo: 30 * DAY });
    await runMaintenance();
    expect(await userExists(confirmed.id)).toBe(true);
  });

  it('EC-M1-03 después del descarte, el mismo correo se registra como nuevo', async () => {
    const stale = await insertUser({ verified: false, registeredAgo: 8 * DAY });
    await runMaintenance();
    expect(await userExists(stale.id)).toBe(false);

    const result = await service.signUp({
      name: 'Ana Pérez',
      email: stale.email,
      password: 'Clave-segura-123',
      termsAccepted: true,
    });
    expect(result.status).toBe('check_email');

    const rows = await db().$queryRaw<{ id: string; verified: boolean; fresh: boolean }[]>`
      SELECT id::text AS id, email_verified AS verified,
             registered_at > now() - interval '1 hour' AS fresh
      FROM auth_user WHERE email = ${stale.email}`;
    expect(rows).toHaveLength(1);
    expect(rows[0]?.id).not.toBe(stale.id);
    expect(rows[0]?.verified).toBe(false);
    expect(rows[0]?.fresh).toBe(true);
    if (rows[0]) userIds.push(rows[0].id);
  });
});

describe('maintenance: purgas de seguridad', () => {
  it('RNF-26 email_send_log de más de 24 h se borra y uno de 23 h no', async () => {
    const old = await insertSendLog(24 * HOUR + MINUTE);
    const recent = await insertSendLog(23 * HOUR);
    await runMaintenance();
    expect(await sendLogExists(old)).toBe(false);
    expect(await sendLogExists(recent)).toBe(true);
  });

  it('RNF-26 login_throttle sin actividad desde hace más de 1 h se borra y uno de 59 min no', async () => {
    const old = await insertThrottle(HOUR + MINUTE);
    const recent = await insertThrottle(59 * MINUTE);
    await runMaintenance();
    expect(await throttleExists(old)).toBe(false);
    expect(await throttleExists(recent)).toBe(true);
  });

  it('RNF-26 el job se puede correr dos veces seguidas sin error', async () => {
    await runMaintenance();
    await expect(runMaintenance()).resolves.toBeUndefined();
  });
});
