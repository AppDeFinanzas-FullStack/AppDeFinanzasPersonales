import { uuidv7 } from 'uuidv7';
import { afterAll, describe, expect, it, vi } from 'vitest';

import type { Repositories } from '../../src/application/ports/repositories.js';
import type { UnitOfWork } from '../../src/application/ports/unit-of-work.js';
import { createLedgerHooks } from '../../src/application/shared/ledger-hooks.js';
import { createUndoActionRepository } from '../../src/infrastructure/persistence/repositories/undo-action.repository.js';
import { createUnitOfWork } from '../../src/infrastructure/persistence/unit-of-work.js';
import { createUser, deleteCreatedUsers, type TestUser } from '../factories/user.factory.js';
import { disconnectTestPrisma, testPrisma } from './setup/db.js';

/**
 * The task fixes the operations (tasks.md, TASK-120, plan §4.0) but not the names of their
 * factories nor their row shapes. These tests assume, like those of TASK-099:
 * - `createUndoActionRepository(tx, userId)` builds the repository over the client of a transaction;
 *   `Repositories` exposes it as `undoActions`. The user comes from the `UnitOfWork`.
 * - `undoActions.create(kind, payload)` returns `{ id, expiresAt }` (`id` is the undoToken, expiry
 *   12 s after creation). `undoActions.consume(id)` returns `{ kind, payload }` the first time
 *   within the 12 s and `null` otherwise (unknown, already consumed, expired or of another user).
 * - `createLedgerHooks()` returns `{ register(handler), afterChange(tx, userId, change) }`; `tx` is
 *   the `Repositories` of the running transaction, and a handler is `(tx, userId, change) => Promise<void>`.
 */
const NIL_USER = '00000000-0000-0000-0000-000000000000';

const uow: UnitOfWork = createUnitOfWork(testPrisma(), (tx, userId) => ({
  undoActions: createUndoActionRepository(tx, userId ?? NIL_USER),
}));

afterAll(async () => {
  await deleteCreatedUsers();
  await disconnectTestPrisma();
});

const withUser = <T>(userId: string, fn: (repos: Repositories) => Promise<T>) =>
  uow.run(fn, { userLock: userId });

async function newUser(): Promise<TestUser> {
  return createUser();
}

async function undoRowCount(id: string): Promise<number> {
  const rows = await testPrisma().$queryRaw<{ n: number }[]>`
    SELECT count(*)::int AS n FROM undo_action WHERE id = ${id}::uuid`;
  return rows[0]?.n ?? 0;
}

const change = () => ({
  dates: ['2026-10-01'],
  categoryIds: [uuidv7()],
  accountIds: [uuidv7()],
});

describe('LedgerHooks', () => {
  it('TASK-120 un handler registrado recibe el cambio, el usuario y la transaccion', async () => {
    const user = await newUser();
    const hooks = createLedgerHooks();
    const handler = vi.fn().mockResolvedValue(undefined);
    hooks.register(handler);
    const c = change();

    await withUser(user.id, (repos) => hooks.afterChange(repos, user.id, c));

    expect(handler).toHaveBeenCalledTimes(1);
    const args = handler.mock.calls[0] as unknown[];
    expect(args[1]).toBe(user.id);
    expect(args[2]).toEqual(c);
  });

  it('TASK-120 afterChange llama a cada handler registrado', async () => {
    const user = await newUser();
    const hooks = createLedgerHooks();
    const first = vi.fn().mockResolvedValue(undefined);
    const second = vi.fn().mockResolvedValue(undefined);
    hooks.register(first);
    hooks.register(second);

    await withUser(user.id, (repos) => hooks.afterChange(repos, user.id, change()));

    expect(first).toHaveBeenCalledTimes(1);
    expect(second).toHaveBeenCalledTimes(1);
  });

  it('TASK-120 sin handlers afterChange no hace nada y no falla', async () => {
    const user = await newUser();
    const hooks = createLedgerHooks();

    await expect(
      withUser(user.id, (repos) => hooks.afterChange(repos, user.id, change())),
    ).resolves.toBeUndefined();
  });

  it('TASK-120 un handler corre en la misma transaccion: lo que escribe lo ve la transaccion', async () => {
    const user = await newUser();
    const hooks = createLedgerHooks();
    let createdId = '';
    hooks.register(async (tx: Repositories) => {
      createdId = (await tx.undoActions.create('delete', { ids: [] })).id;
    });

    const seen = await withUser(user.id, async (repos) => {
      await hooks.afterChange(repos, user.id, change());
      return repos.undoActions.consume(createdId);
    });

    expect(seen).not.toBeNull();
  });

  it('TASK-120 si un handler lanza un error, la transaccion se revierte', async () => {
    const user = await newUser();
    const hooks = createLedgerHooks();
    hooks.register(() => Promise.reject(new Error('hook boom')));
    let writtenId = '';

    await expect(
      withUser(user.id, async (repos) => {
        writtenId = (await repos.undoActions.create('delete', { ids: [uuidv7()] })).id;
        await hooks.afterChange(repos, user.id, change());
      }),
    ).rejects.toThrow('hook boom');

    expect(writtenId).not.toBe('');
    expect(await undoRowCount(writtenId)).toBe(0);
  });
});

describe('undo_action repository', () => {
  it('TASK-120 create guarda la accion con vencimiento a los 12 s', async () => {
    const user = await newUser();
    const payload = { ids: [uuidv7(), uuidv7()] };
    const before = Date.now();

    const created = await withUser(user.id, (repos) => repos.undoActions.create('delete', payload));

    const rows = await testPrisma().$queryRaw<
      { user_id: string; kind: string; payload: unknown; expires_at: Date; consumed_at: Date | null }[]
    >`SELECT user_id::text, kind::text, payload, expires_at, consumed_at
        FROM undo_action WHERE id = ${created.id}::uuid`;
    expect(rows).toHaveLength(1);
    const row = rows[0];
    expect(row?.user_id).toBe(user.id);
    expect(row?.kind).toBe('delete');
    expect(row?.payload).toEqual(payload);
    expect(row?.consumed_at).toBeNull();
    const ttl = (row?.expires_at.getTime() ?? 0) - before;
    expect(ttl).toBeGreaterThan(10_000);
    expect(ttl).toBeLessThan(14_000);
  });

  it('TASK-120 consume dentro de los 12 s devuelve la accion', async () => {
    const user = await newUser();
    const payload = { ids: [uuidv7()] };
    const { id } = await withUser(user.id, (repos) =>
      repos.undoActions.create('recategorize', payload),
    );

    const consumed = await withUser(user.id, (repos) => repos.undoActions.consume(id));

    expect(consumed).toEqual({ kind: 'recategorize', payload });
  });

  it('TASK-120 consume solo funciona una vez', async () => {
    const user = await newUser();
    const { id } = await withUser(user.id, (repos) => repos.undoActions.create('delete', {}));

    const first = await withUser(user.id, (repos) => repos.undoActions.consume(id));
    const second = await withUser(user.id, (repos) => repos.undoActions.consume(id));

    expect(first).not.toBeNull();
    expect(second).toBeNull();
  });

  it('TASK-120 dos consume simultaneos: solo uno gana', async () => {
    const user = await newUser();
    const { id } = await withUser(user.id, (repos) => repos.undoActions.create('create', {}));

    const results = await Promise.all([
      withUser(user.id, (repos) => repos.undoActions.consume(id)),
      withUser(user.id, (repos) => repos.undoActions.consume(id)),
    ]);

    expect(results.filter((r) => r !== null)).toHaveLength(1);
  });

  it('TASK-120 consume vencido (pasados los 12 s) devuelve null y no marca la accion', async () => {
    const user = await newUser();
    const { id } = await withUser(user.id, (repos) => repos.undoActions.create('delete', {}));
    await testPrisma().$executeRaw`
      UPDATE undo_action SET expires_at = now() - interval '1 second' WHERE id = ${id}::uuid`;

    const consumed = await withUser(user.id, (repos) => repos.undoActions.consume(id));

    expect(consumed).toBeNull();
    const rows = await testPrisma().$queryRaw<{ consumed_at: Date | null }[]>`
      SELECT consumed_at FROM undo_action WHERE id = ${id}::uuid`;
    expect(rows[0]?.consumed_at).toBeNull();
  });

  it('TASK-120 consume de un id desconocido devuelve null', async () => {
    const user = await newUser();

    const consumed = await withUser(user.id, (repos) => repos.undoActions.consume(uuidv7()));

    expect(consumed).toBeNull();
  });

  it('TASK-120 aislamiento: otro usuario no puede consumir la accion', async () => {
    const owner = await newUser();
    const other = await newUser();
    const { id } = await withUser(owner.id, (repos) => repos.undoActions.create('delete', {}));

    const stolen = await withUser(other.id, (repos) => repos.undoActions.consume(id));
    const rightful = await withUser(owner.id, (repos) => repos.undoActions.consume(id));

    expect(stolen).toBeNull();
    expect(rightful).not.toBeNull();
  });
});
