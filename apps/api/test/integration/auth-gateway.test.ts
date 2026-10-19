import { uuidv7 } from 'uuidv7';
import { afterAll, describe, expect, it } from 'vitest';

import { createBetterAuthGateway } from '../../src/infrastructure/auth/better-auth.js';
import { createUser, deleteCreatedUsers } from '../factories/user.factory.js';
import { disconnectTestPrisma, testPrisma } from './setup/db.js';

/**
 * The plan (ADR-08, S-1) fixes the operations of the gateway but not their signatures. These tests
 * use:
 * - `createBetterAuthGateway({ prisma, secret })`: the gateway over the Better Auth server API,
 *   with the `auth_*` tables of the test database;
 * - `hashPassword(password)` -> scrypt hash; `verifyPassword(hash, password)` -> boolean;
 * - `createSession(userId)` -> `{ sessionId, token, cookie }`, where `cookie` is the full
 *   `Set-Cookie` header value (`HttpOnly; Secure; SameSite=Lax`) and carries the token;
 * - `getSession(token)` -> `{ sessionId, userId }` or `null` when the token is unknown;
 * - `deleteSession(sessionId)`; `revokeSessions(userId, exceptSessionId?)`;
 * - `markEmailVerified(userId)`.
 */
const gateway = createBetterAuthGateway({
  prisma: testPrisma(),
  secret: 'test-secret-test-secret-test-secret-0123',
});

async function sessionIdsOf(userId: string): Promise<string[]> {
  const rows = await testPrisma().$queryRaw<{ id: string }[]>`
    SELECT id::text AS id FROM auth_session WHERE user_id = ${userId}::uuid`;
  return rows.map((row) => row.id);
}

afterAll(async () => {
  await deleteCreatedUsers();
  await disconnectTestPrisma();
});

describe('contraseñas', () => {
  it('TASK-050 hashPassword produce un hash scrypt que verifyPassword reconoce', async () => {
    const hash = await gateway.hashPassword('Clave-segura-123');

    expect(hash).not.toContain('Clave-segura-123');
    expect(await gateway.verifyPassword(hash, 'Clave-segura-123')).toBe(true);
    expect(await gateway.verifyPassword(hash, 'otra-clave')).toBe(false);
  });

  it('TASK-050 dos hashes de la misma contraseña difieren (sal aleatoria)', async () => {
    const first = await gateway.hashPassword('Clave-segura-123');
    const second = await gateway.hashPassword('Clave-segura-123');

    expect(first).not.toBe(second);
  });
});

describe('sesiones', () => {
  it('TASK-050 se crea una sesión y su cookie desde código propio, y getSession la reconoce', async () => {
    const user = await createUser();

    const created = await gateway.createSession(user.id);

    expect(created.cookie).toMatch(/HttpOnly/i);
    expect(created.cookie).toMatch(/Secure/i);
    expect(created.cookie).toMatch(/SameSite=Lax/i);
    expect(decodeURIComponent(created.cookie)).toContain(created.token);
    expect(await sessionIdsOf(user.id)).toEqual([created.sessionId]);

    const found = await gateway.getSession(created.token);
    expect(found?.userId).toBe(user.id);
    expect(found?.sessionId).toBe(created.sessionId);
  });

  it('TASK-050 getSession devuelve null con un token desconocido', async () => {
    expect(await gateway.getSession(`no-existe-${uuidv7()}`)).toBeNull();
  });

  it('TASK-050 deleteSession borra la sesión y getSession deja de reconocerla', async () => {
    const user = await createUser();
    const created = await gateway.createSession(user.id);

    await gateway.deleteSession(created.sessionId);

    expect(await gateway.getSession(created.token)).toBeNull();
    expect(await sessionIdsOf(user.id)).toEqual([]);
  });

  it('RF-M1-07 dos sesiones del mismo usuario coexisten', async () => {
    const user = await createUser();

    const first = await gateway.createSession(user.id);
    const second = await gateway.createSession(user.id);

    expect(first.sessionId).not.toBe(second.sessionId);
    expect(first.token).not.toBe(second.token);
    expect((await gateway.getSession(first.token))?.userId).toBe(user.id);
    expect((await gateway.getSession(second.token))?.userId).toBe(user.id);
    expect((await sessionIdsOf(user.id)).sort()).toEqual(
      [first.sessionId, second.sessionId].sort(),
    );
  });

  it('RF-M1-07 revokeSessions con exceptSessionId conserva solo esa sesión', async () => {
    const user = await createUser();
    const keep = await gateway.createSession(user.id);
    const other = await gateway.createSession(user.id);
    const third = await gateway.createSession(user.id);

    await gateway.revokeSessions(user.id, keep.sessionId);

    expect(await sessionIdsOf(user.id)).toEqual([keep.sessionId]);
    expect((await gateway.getSession(keep.token))?.userId).toBe(user.id);
    expect(await gateway.getSession(other.token)).toBeNull();
    expect(await gateway.getSession(third.token)).toBeNull();
  });

  it('RF-M1-07 revokeSessions sin exceptSessionId cierra todas las sesiones del usuario', async () => {
    const user = await createUser();
    const first = await gateway.createSession(user.id);
    const second = await gateway.createSession(user.id);

    await gateway.revokeSessions(user.id);

    expect(await sessionIdsOf(user.id)).toEqual([]);
    expect(await gateway.getSession(first.token)).toBeNull();
    expect(await gateway.getSession(second.token)).toBeNull();
  });

  it('RF-M1-07 revokeSessions no toca las sesiones de otro usuario', async () => {
    const mine = await createUser();
    const theirs = await createUser();
    await gateway.createSession(mine.id);
    const foreign = await gateway.createSession(theirs.id);

    await gateway.revokeSessions(mine.id);

    expect(await sessionIdsOf(mine.id)).toEqual([]);
    expect((await gateway.getSession(foreign.token))?.userId).toBe(theirs.id);
  });
});

describe('correo verificado', () => {
  it('TASK-050 markEmailVerified marca el correo del usuario como verificado', async () => {
    const user = await createUser();
    await testPrisma()
      .$executeRaw`UPDATE auth_user SET email_verified = false WHERE id = ${user.id}::uuid`;

    await gateway.markEmailVerified(user.id);

    const rows = await testPrisma().$queryRaw<{ verified: boolean }[]>`
      SELECT email_verified AS verified FROM auth_user WHERE id = ${user.id}::uuid`;
    expect(rows[0]?.verified).toBe(true);
  });
});
