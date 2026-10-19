import { createHmac, randomUUID } from 'node:crypto';

import { afterAll, describe, expect, it } from 'vitest';

import type { UnitOfWork } from '../../src/application/ports/unit-of-work.js';
import { createLoginThrottle } from '../../src/application/shared/login-throttle.js';
import { createLoginThrottleRepository } from '../../src/infrastructure/persistence/repositories/login-throttle.repository.js';
import { createUnitOfWork } from '../../src/infrastructure/persistence/unit-of-work.js';
import { createUser, deleteCreatedUsers } from '../factories/user.factory.js';
import { disconnectTestPrisma, testPrisma } from './setup/db.js';

/**
 * The plan fixes the `login_throttle` table (§3.3), the atomic `INSERT ... ON CONFLICT` (§4.1.3)
 * and the HMAC-SHA256 key (§3.9), but not the names of the pieces. These tests use:
 * - `createLoginThrottleRepository(tx)`: the repository bound to the transaction of a
 *   `UnitOfWork` run, exposed as `repos.loginThrottle`;
 * - `createLoginThrottle({ uow, hmacSecret })`: the service with `check(email)` (seconds left of
 *   the wait, `0` when there is none), `fail(email)`, `reset(email)` and `shouldAlert(email)`
 *   (`true` at most once per hour).
 * The row key is the lowercase hex HMAC-SHA256 of the lowercased email under `hmacSecret`.
 * Time is the database's: tests move it by editing the rows.
 */
const HMAC_SECRET = 'hmac-secret-for-the-login-throttle-test';

const uow: UnitOfWork = createUnitOfWork(testPrisma(), (tx) => ({
  loginThrottle: createLoginThrottleRepository(tx),
}));
const throttle = createLoginThrottle({ uow, hmacSecret: HMAC_SECRET });

const hmacOf = (email: string) =>
  createHmac('sha256', HMAC_SECRET).update(email.toLowerCase()).digest('hex');

const freshEmail = () => `${randomUUID()}@throttle.test`;

interface ThrottleRow {
  emailHmac: string;
  consecutiveFailures: number;
  lockSeconds: number | null;
}

async function rowOf(email: string): Promise<ThrottleRow | undefined> {
  const rows = await testPrisma().$queryRaw<ThrottleRow[]>`
    SELECT email_hmac AS "emailHmac", consecutive_failures AS "consecutiveFailures",
           extract(epoch FROM locked_until - now())::float AS "lockSeconds"
    FROM login_throttle WHERE email_hmac = ${hmacOf(email)}`;
  return rows[0];
}

async function failTimes(email: string, times: number): Promise<void> {
  for (let i = 0; i < times; i += 1) {
    await throttle.fail(email);
  }
}

async function backdate(email: string, column: string, interval: string): Promise<void> {
  const allowed = ['last_failure_at', 'locked_until', 'last_alert_sent_at'];
  if (!allowed.includes(column)) throw new Error('unexpected column');
  await testPrisma().$executeRawUnsafe(
    `UPDATE login_throttle SET ${column} = now() - interval '${interval}' WHERE email_hmac = $1`,
    hmacOf(email),
  );
}

afterAll(async () => {
  await testPrisma().$executeRaw`DELETE FROM login_throttle WHERE true`;
  await deleteCreatedUsers();
  await disconnectTestPrisma();
});

describe('login throttle: waits', () => {
  it('RF-M1-08 fewer than 5 failures give no wait', async () => {
    const email = freshEmail();
    await failTimes(email, 4);

    expect(await throttle.check(email)).toBe(0);
    expect((await rowOf(email))?.consecutiveFailures).toBe(4);
  });

  it('RF-M1-08 an email that never failed has no wait', async () => {
    expect(await throttle.check(freshEmail())).toBe(0);
  });

  it('RF-M1-08 5 failures give a 60 second wait', async () => {
    const email = freshEmail();
    await failTimes(email, 5);

    const seconds = await throttle.check(email);
    expect(seconds).toBeGreaterThan(55);
    expect(seconds).toBeLessThanOrEqual(60);
    const row = await rowOf(email);
    expect(row?.lockSeconds).toBeGreaterThan(55);
    expect(row?.lockSeconds).toBeLessThanOrEqual(60);
  });

  it('RF-M1-08 10 failures give a 15 minute wait', async () => {
    const email = freshEmail();
    await failTimes(email, 10);

    const seconds = await throttle.check(email);
    expect(seconds).toBeGreaterThan(14 * 60 + 55);
    expect(seconds).toBeLessThanOrEqual(15 * 60);
  });

  it('RF-M1-08 every failure after the 10th gives 15 minutes again', async () => {
    const email = freshEmail();
    await failTimes(email, 10);
    await backdate(email, 'locked_until', '1 second');
    expect(await throttle.check(email)).toBe(0);

    await throttle.fail(email);

    const seconds = await throttle.check(email);
    expect(seconds).toBeGreaterThan(14 * 60 + 55);
    expect(seconds).toBeLessThanOrEqual(15 * 60);
    expect((await rowOf(email))?.consecutiveFailures).toBe(11);
  });

  it('RF-M1-08 the wait is never permanent: it ends and the email can try again', async () => {
    const email = freshEmail();
    await failTimes(email, 10);
    await backdate(email, 'locked_until', '1 second');

    expect(await throttle.check(email)).toBe(0);
  });

  it('RF-M1-08 the email is stored only as its HMAC-SHA256, case-insensitively', async () => {
    const email = freshEmail();
    await throttle.fail(email);
    await throttle.fail(email.toUpperCase());

    const row = await rowOf(email);
    expect(row?.emailHmac.trim()).toBe(hmacOf(email));
    expect(row?.consecutiveFailures).toBe(2);
    const leaked = await testPrisma().$queryRaw<{ n: number }[]>`
      SELECT count(*)::int AS n FROM login_throttle WHERE email_hmac LIKE ${'%throttle.test%'}`;
    expect(leaked[0]?.n).toBe(0);
  });

  it('RF-M1-08 simultaneous failures are all counted', async () => {
    const email = freshEmail();
    await Promise.all(Array.from({ length: 5 }, () => throttle.fail(email)));

    expect((await rowOf(email))?.consecutiveFailures).toBe(5);
    expect(await throttle.check(email)).toBeGreaterThan(55);
  });

  it('RF-M1-08 the failures of one email do not affect another', async () => {
    const email = freshEmail();
    const other = freshEmail();
    await failTimes(email, 5);

    expect(await throttle.check(other)).toBe(0);
  });
});

describe('login throttle: reset', () => {
  it('RF-M1-08 a successful login resets the counter and the wait', async () => {
    const email = freshEmail();
    await failTimes(email, 5);
    expect(await throttle.check(email)).toBeGreaterThan(0);

    await throttle.reset(email);

    expect(await throttle.check(email)).toBe(0);
    await failTimes(email, 4);
    expect(await throttle.check(email)).toBe(0);
  });

  it('RF-M1-08 reset on an email without failures does nothing', async () => {
    const email = freshEmail();

    await throttle.reset(email);

    expect(await throttle.check(email)).toBe(0);
  });

  it('RF-M1-08 the counter restarts after 1 hour without attempts', async () => {
    const email = freshEmail();
    await failTimes(email, 4);
    await backdate(email, 'last_failure_at', '61 minutes');

    await throttle.fail(email);

    expect((await rowOf(email))?.consecutiveFailures).toBe(1);
    await failTimes(email, 3);
    expect(await throttle.check(email)).toBe(0);
  });

  it('RF-M1-08 within the hour the counter keeps growing', async () => {
    const email = freshEmail();
    await failTimes(email, 4);
    await backdate(email, 'last_failure_at', '59 minutes');

    await throttle.fail(email);

    expect((await rowOf(email))?.consecutiveFailures).toBe(5);
    expect(await throttle.check(email)).toBeGreaterThan(55);
  });
});

describe('login throttle: alert', () => {
  it('RF-M1-08 the alert goes out once and not again within the hour', async () => {
    const email = freshEmail();
    await failTimes(email, 5);

    expect(await throttle.shouldAlert(email)).toBe(true);
    expect(await throttle.shouldAlert(email)).toBe(false);
  });

  it('RF-M1-08 the alert can go out again after an hour', async () => {
    const email = freshEmail();
    await failTimes(email, 5);
    await throttle.shouldAlert(email);
    await backdate(email, 'last_alert_sent_at', '61 minutes');

    expect(await throttle.shouldAlert(email)).toBe(true);
    expect(await throttle.shouldAlert(email)).toBe(false);
  });

  it('RF-M1-08 an alert 59 minutes ago still blocks a new one', async () => {
    const email = freshEmail();
    await failTimes(email, 5);
    await throttle.shouldAlert(email);
    await backdate(email, 'last_alert_sent_at', '59 minutes');

    expect(await throttle.shouldAlert(email)).toBe(false);
  });

  it('RF-M1-08 simultaneous checks give a single alert', async () => {
    const email = freshEmail();
    await failTimes(email, 5);

    const results = await Promise.all([
      throttle.shouldAlert(email),
      throttle.shouldAlert(email),
      throttle.shouldAlert(email),
    ]);

    expect(results.filter(Boolean)).toHaveLength(1);
  });
});

describe('login throttle: remaining time and unknown emails', () => {
  it('EC-M1-04 during the wait check reports the remaining time, which shrinks', async () => {
    const email = freshEmail();
    await failTimes(email, 5);
    const first = await throttle.check(email);
    await testPrisma().$executeRawUnsafe(
      `UPDATE login_throttle SET locked_until = locked_until - interval '30 seconds' WHERE email_hmac = $1`,
      hmacOf(email),
    );

    const second = await throttle.check(email);

    expect(Number.isInteger(first)).toBe(true);
    expect(first).toBeGreaterThan(0);
    expect(second).toBeGreaterThan(0);
    expect(second).toBeLessThan(first - 25);
  });

  it('EC-M1-04 the wait applies whatever the password is: check does not depend on it', async () => {
    const user = await createUser();
    await failTimes(user.email, 5);

    expect(await throttle.check(user.email)).toBeGreaterThan(55);
  });

  it('EC-M1-12 an email without an account gets the same wait as one with an account', async () => {
    const user = await createUser();
    const ghost = freshEmail();
    await failTimes(user.email, 5);
    await failTimes(ghost, 5);

    const withAccount = await throttle.check(user.email);
    const withoutAccount = await throttle.check(ghost);
    expect(Math.abs(withAccount - withoutAccount)).toBeLessThanOrEqual(2);
    expect(withoutAccount).toBeGreaterThan(55);

    await failTimes(user.email, 5);
    await failTimes(ghost, 5);
    expect(await throttle.check(ghost)).toBeGreaterThan(14 * 60 + 55);
    expect(await throttle.check(user.email)).toBeGreaterThan(14 * 60 + 55);
  });
});
