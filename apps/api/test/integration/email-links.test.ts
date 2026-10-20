import { createHash } from 'node:crypto';

import { afterAll, describe, expect, it } from 'vitest';

import type { UnitOfWork } from '../../src/application/ports/unit-of-work.js';
import { createEmailLinkRepository } from '../../src/infrastructure/persistence/repositories/email-link.repository.js';
import { createUnitOfWork } from '../../src/infrastructure/persistence/unit-of-work.js';
import { createUser, deleteCreatedUsers } from '../factories/user.factory.js';
import { disconnectTestPrisma, testPrisma } from './setup/db.js';

/**
 * The plan fixes the `email_link` table (§3.3) and the single-use `UPDATE ... RETURNING`
 * (§4.1.3), but not the names of the pieces. These tests use:
 * - `createEmailLinkRepository(tx)`: the repository bound to the transaction of a `UnitOfWork`
 *   run, exposed as `repos.emailLinks`;
 * - `create(userId, purpose)`: invalidates the user's current link of that purpose, stores only
 *   the SHA-256 (hex) of a random 32-byte token and resolves `{ token, expiresAt }`;
 * - `consume(token, purpose)`: resolves `{ ok: true, userId, purpose }` for the one request that
 *   wins, or `{ ok: false, reason }` with `reason` `LINK_INVALID` (expired, invalidated, unknown)
 *   or `LINK_ALREADY_USED` (used before).
 */
const uow: UnitOfWork = createUnitOfWork(testPrisma(), (tx) => ({
  emailLinks: createEmailLinkRepository(tx),
}));

type Purpose = 'confirm_email' | 'reset_password';

interface LinkRow {
  tokenHash: string;
  usedAt: Date | null;
  invalidatedAt: Date | null;
  lifetimeSeconds: number;
}

const create = (userId: string, purpose: Purpose) =>
  uow.run((repos) => repos.emailLinks.create(userId, purpose));

const consume = (token: string, purpose: Purpose) =>
  uow.run((repos) => repos.emailLinks.consume(token, purpose));

const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');

async function rowsOf(userId: string, purpose: Purpose): Promise<LinkRow[]> {
  return testPrisma().$queryRaw<LinkRow[]>`
    SELECT token_hash AS "tokenHash", used_at AS "usedAt", invalidated_at AS "invalidatedAt",
           extract(epoch FROM expires_at - created_at)::int AS "lifetimeSeconds"
    FROM email_link WHERE user_id = ${userId}::uuid AND purpose = ${purpose}::email_link_purpose`;
}

async function expire(token: string): Promise<void> {
  await testPrisma().$executeRaw`
    UPDATE email_link SET expires_at = now() - interval '1 second'
    WHERE token_hash = ${sha256(token)}`;
}

afterAll(async () => {
  await deleteCreatedUsers();
  await disconnectTestPrisma();
});

describe('email links: create', () => {
  it('TASK-051 plan §3.9 stores only the SHA-256 of a random 32-byte token', async () => {
    const user = await createUser();
    const { token } = await create(user.id, 'confirm_email');
    const other = await create((await createUser()).id, 'confirm_email');

    expect(token).not.toBe(other.token);
    // 32 bytes need at least 43 characters in any text encoding (base64url) and 64 in hex.
    expect(token.length).toBeGreaterThanOrEqual(43);
    const rows = await rowsOf(user.id, 'confirm_email');
    expect(rows).toHaveLength(1);
    expect(rows[0]?.tokenHash.trim()).toBe(sha256(token));
    expect(rows[0]?.tokenHash).not.toContain(token);
  });

  it('RF-M1-05 plan §4.1.3 a confirmation link lasts 24 hours', async () => {
    const user = await createUser();
    const { expiresAt } = await create(user.id, 'confirm_email');

    const [row] = await rowsOf(user.id, 'confirm_email');
    expect(row?.lifetimeSeconds).toBe(24 * 60 * 60);
    expect(expiresAt.getTime()).toBeGreaterThan(Date.now() + 23 * 60 * 60 * 1000);
  });

  it('RF-M1-09 a recovery link lasts 1 hour', async () => {
    const user = await createUser();
    const { expiresAt } = await create(user.id, 'reset_password');

    const [row] = await rowsOf(user.id, 'reset_password');
    expect(row?.lifetimeSeconds).toBe(60 * 60);
    expect(expiresAt.getTime()).toBeLessThanOrEqual(Date.now() + 60 * 60 * 1000 + 5_000);
    expect(expiresAt.getTime()).toBeGreaterThan(Date.now() + 55 * 60 * 1000);
  });

  it('RF-M1-05 creating a new link invalidates the previous one', async () => {
    const user = await createUser();
    const first = await create(user.id, 'confirm_email');
    const second = await create(user.id, 'confirm_email');

    const rows = await rowsOf(user.id, 'confirm_email');
    expect(rows).toHaveLength(2);
    const old = rows.find((row) => row.tokenHash.trim() === sha256(first.token));
    expect(old?.invalidatedAt).not.toBeNull();
    const current = rows.find((row) => row.tokenHash.trim() === sha256(second.token));
    expect(current?.invalidatedAt).toBeNull();

    expect(await consume(first.token, 'confirm_email')).toEqual({
      ok: false,
      reason: 'LINK_INVALID',
    });
    expect(await consume(second.token, 'confirm_email')).toEqual({
      ok: true,
      userId: user.id,
      purpose: 'confirm_email',
    });
  });

  it('RF-M1-09 asking for a new recovery link invalidates the previous one', async () => {
    const user = await createUser();
    const first = await create(user.id, 'reset_password');
    const second = await create(user.id, 'reset_password');

    expect(await consume(first.token, 'reset_password')).toEqual({
      ok: false,
      reason: 'LINK_INVALID',
    });
    expect(await consume(second.token, 'reset_password')).toMatchObject({ ok: true });
  });

  it('RF-M1-05 a new link leaves other purposes and other users untouched', async () => {
    const user = await createUser();
    const stranger = await createUser();
    const confirm = await create(user.id, 'confirm_email');
    const strangerConfirm = await create(stranger.id, 'confirm_email');
    await create(user.id, 'reset_password');
    await create(user.id, 'reset_password');

    expect(await consume(confirm.token, 'confirm_email')).toMatchObject({
      ok: true,
      userId: user.id,
    });
    expect(await consume(strangerConfirm.token, 'confirm_email')).toMatchObject({
      ok: true,
      userId: stranger.id,
    });
  });

  it('RF-M1-05 a used link is not marked as invalidated by a later one', async () => {
    const user = await createUser();
    const first = await create(user.id, 'confirm_email');
    await consume(first.token, 'confirm_email');
    await create(user.id, 'confirm_email');

    const rows = await rowsOf(user.id, 'confirm_email');
    const used = rows.find((row) => row.tokenHash.trim() === sha256(first.token));
    expect(used?.usedAt).not.toBeNull();
    expect(used?.invalidatedAt).toBeNull();
  });
});

describe('email links: consume', () => {
  it('RF-M1-09 a link works once and the second use is rejected', async () => {
    const user = await createUser();
    const { token } = await create(user.id, 'reset_password');

    expect(await consume(token, 'reset_password')).toEqual({
      ok: true,
      userId: user.id,
      purpose: 'reset_password',
    });
    expect(await consume(token, 'reset_password')).toEqual({
      ok: false,
      reason: 'LINK_ALREADY_USED',
    });
  });

  it('RF-M1-09 two simultaneous consumptions give a single success', async () => {
    const user = await createUser();
    const { token } = await create(user.id, 'confirm_email');

    const results = await Promise.all([
      consume(token, 'confirm_email'),
      consume(token, 'confirm_email'),
      consume(token, 'confirm_email'),
    ]);

    expect(results.filter((result) => result.ok)).toHaveLength(1);
    for (const result of results.filter((item) => !item.ok)) {
      expect(result).toMatchObject({ ok: false });
    }
    const [row] = await rowsOf(user.id, 'confirm_email');
    expect(row?.usedAt).not.toBeNull();
  });

  it('EC-M1-01 an expired link gives LINK_INVALID', async () => {
    const user = await createUser();
    const { token } = await create(user.id, 'confirm_email');
    await expire(token);

    expect(await consume(token, 'confirm_email')).toEqual({
      ok: false,
      reason: 'LINK_INVALID',
    });
    const [row] = await rowsOf(user.id, 'confirm_email');
    expect(row?.usedAt).toBeNull();
  });

  it('EC-M1-01 an invalidated link gives LINK_INVALID', async () => {
    const user = await createUser();
    const { token } = await create(user.id, 'confirm_email');
    await create(user.id, 'confirm_email');

    expect(await consume(token, 'confirm_email')).toEqual({
      ok: false,
      reason: 'LINK_INVALID',
    });
  });

  it('EC-M1-01 a token that was never issued gives LINK_INVALID', async () => {
    expect(await consume('x'.repeat(43), 'confirm_email')).toEqual({
      ok: false,
      reason: 'LINK_INVALID',
    });
  });

  it('EC-M1-02 a link that was already used gives LINK_ALREADY_USED', async () => {
    const user = await createUser();
    const { token } = await create(user.id, 'confirm_email');
    await consume(token, 'confirm_email');

    expect(await consume(token, 'confirm_email')).toEqual({
      ok: false,
      reason: 'LINK_ALREADY_USED',
    });
  });
});
