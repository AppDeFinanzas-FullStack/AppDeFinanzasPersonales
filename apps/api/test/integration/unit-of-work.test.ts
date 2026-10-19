import { afterAll, describe, expect, it } from 'vitest';

import { AppError } from '../../src/application/errors.js';
import type { Repositories } from '../../src/application/ports/repositories.js';
import type { UnitOfWork } from '../../src/application/ports/unit-of-work.js';
import { createUnitOfWork } from '../../src/infrastructure/persistence/unit-of-work.js';
import { createUser, deleteCreatedUsers } from '../factories/user.factory.js';
import { disconnectTestPrisma, testPrisma } from './setup/db.js';

/**
 * The plan fixes the port (`UnitOfWork.run(fn, { userLock?, readOnly? })`) but not how its Prisma
 * implementation is built. These tests use `createUnitOfWork(prisma, buildRepositories)`:
 * `buildRepositories` receives the client of each transaction and returns the repositories bound
 * to it. `Repositories` has no members yet, so the test binds a probe that only exposes that client.
 */
interface TxDb {
  $executeRawUnsafe(query: string, ...values: unknown[]): Promise<number>;
  $queryRawUnsafe<T = unknown>(query: string, ...values: unknown[]): Promise<T>;
}

type ProbeRepositories = Repositories & { db: TxDb };

/** Built on an empty `Repositories` so it keeps compiling when modules add their repositories. */
const buildProbeRepositories = (db: TxDb): Repositories =>
  Object.assign(Object.create(null) as Repositories, { db });

const uow: UnitOfWork = createUnitOfWork(testPrisma(), buildProbeRepositories);

/** Transaction client handed to `fn` through its repositories. */
const txOf = (repos: Repositories): TxDb => (repos as ProbeRepositories).db;

afterAll(async () => {
  await deleteCreatedUsers();
  await disconnectTestPrisma();
});

// ---------- Helpers ----------

const sleep = (ms: number) =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });

function deferred() {
  let resolve: () => void = () => undefined;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

/** Time a blocked `run` gets to show that it does not move forward. */
const BLOCKED_WINDOW_MS = 400;

/** Upper bound for a `run` that must not wait for another one. */
const PARALLEL_LIMIT_MS = 2_000;

/**
 * Whether the per-user lock is free, asked from another connection without waiting:
 * `pg_try_advisory_xact_lock` takes the lock and releases it at the end of its own statement.
 */
async function userLockIsFree(userId: string): Promise<boolean> {
  const rows = await testPrisma().$queryRaw<{ free: boolean }[]>`
    SELECT pg_try_advisory_xact_lock(hashtext('user:' || ${userId}::text)) AS free`;
  return rows[0]?.free ?? false;
}

/** Name of a user, read outside of any UnitOfWork. */
async function nameOf(userId: string): Promise<string | undefined> {
  const rows = await testPrisma().$queryRaw<{ name: string }[]>`
    SELECT name FROM auth_user WHERE id = ${userId}::uuid`;
  return rows[0]?.name;
}

/** Currency codes of a user, read outside of any UnitOfWork. */
async function currencyCodes(userId: string): Promise<string[]> {
  const rows = await testPrisma().$queryRaw<{ code: string }[]>`
    SELECT code FROM currency WHERE user_id = ${userId}::uuid ORDER BY code`;
  return rows.map((row) => row.code);
}

const RENAME = 'UPDATE auth_user SET name = $2 WHERE id = $1::uuid';
const INSERT_EUR = `INSERT INTO currency (user_id, code, symbol) VALUES ($1::uuid, 'EUR', '€')`;
const SELECT_NAME = 'SELECT name FROM auth_user WHERE id = $1::uuid';

// ---------- Tests ----------

describe('UnitOfWork.run', () => {
  it('TASK-033 run devuelve el resultado de fn y confirma sus escrituras', async () => {
    const user = await createUser({ name: 'Ana' });

    const result = await uow.run(
      async (repos) => {
        await txOf(repos).$executeRawUnsafe(RENAME, user.id, 'Beto');
        return 'listo';
      },
      { userLock: user.id },
    );

    expect(result).toBe('listo');
    expect(await nameOf(user.id)).toBe('Beto');
  });
});

describe('UnitOfWork.run con userLock', () => {
  it('RNF-10 dos run concurrentes con el mismo userLock se serializan: el segundo empieza cuando el primero termina', async () => {
    const user = await createUser();
    const events: string[] = [];
    const firstEntered = deferred();
    const releaseFirst = deferred();

    const first = uow.run(
      async () => {
        events.push('A:start');
        firstEntered.resolve();
        await releaseFirst.promise;
        events.push('A:end');
      },
      { userLock: user.id },
    );
    let second: Promise<void> | undefined;
    try {
      await firstEntered.promise;
      second = uow.run(
        () => {
          events.push('B:start');
          return Promise.resolve();
        },
        { userLock: user.id },
      );
      await sleep(BLOCKED_WINDOW_MS);
      expect(events).toEqual(['A:start']);

      releaseFirst.resolve();
      await Promise.all([first, second]);
      expect(events).toEqual(['A:start', 'A:end', 'B:start']);
    } finally {
      releaseFirst.resolve();
      await Promise.allSettled([first, second]);
    }
  });

  it('RNF-10 con el mismo userLock, cada run lee lo que guardó el anterior y ninguna escritura se pierde', async () => {
    const user = await createUser({ name: 'U' });

    const append = (suffix: string) =>
      uow.run(
        async (repos) => {
          const tx = txOf(repos);
          const rows = await tx.$queryRawUnsafe<{ name: string }[]>(SELECT_NAME, user.id);
          const current = rows[0]?.name ?? '';
          await sleep(200);
          await tx.$executeRawUnsafe(RENAME, user.id, `${current}${suffix}`);
        },
        { userLock: user.id },
      );

    await Promise.all([append('a'), append('b')]);

    expect(['Uab', 'Uba']).toContain(await nameOf(user.id));
  });

  it('RNF-10 dos run con userLock de usuarios distintos corren en paralelo', async () => {
    const [ana, beto] = await Promise.all([createUser(), createUser()]);
    const firstEntered = deferred();
    const releaseFirst = deferred();

    const first = uow.run(
      async () => {
        firstEntered.resolve();
        await releaseFirst.promise;
      },
      { userLock: ana.id },
    );
    let second: Promise<string> | undefined;
    try {
      await firstEntered.promise;
      second = uow.run(() => Promise.resolve('B terminó'), { userLock: beto.id });

      const winner = await Promise.race([
        second,
        sleep(PARALLEL_LIMIT_MS).then(() => 'B sigue esperando'),
      ]);
      expect(winner).toBe('B terminó');
    } finally {
      releaseFirst.resolve();
      await Promise.allSettled([first, second]);
    }
  });

  it("TASK-033 con userLock, fn corre con pg_advisory_xact_lock(hashtext('user:' || id)) tomado, y el bloqueo se suelta al confirmar", async () => {
    const user = await createUser();
    expect(await userLockIsFree(user.id)).toBe(true);

    const freeWhileRunning = await uow.run(() => userLockIsFree(user.id), { userLock: user.id });

    expect(freeWhileRunning).toBe(false);
    expect(await userLockIsFree(user.id)).toBe(true);
  });

  it('TASK-033 si fn falla, el bloqueo del usuario se suelta con la transacción', async () => {
    const user = await createUser();

    await expect(
      uow.run(() => Promise.reject(new AppError('VALIDATION_ERROR')), { userLock: user.id }),
    ).rejects.toBeInstanceOf(AppError);

    expect(await userLockIsFree(user.id)).toBe(true);
    const next = await Promise.race([
      uow.run(() => Promise.resolve('siguiente'), { userLock: user.id }),
      sleep(PARALLEL_LIMIT_MS).then(() => 'bloqueado'),
    ]);
    expect(next).toBe('siguiente');
  });
});

describe('UnitOfWork.run revierte ante un error', () => {
  it('TASK-033 un error dentro de fn revierte todas sus escrituras y run lo propaga tal cual', async () => {
    const user = await createUser({ name: 'Ana' });
    const error = new AppError('VALIDATION_ERROR', { field: 'name' });

    await expect(
      uow.run(
        async (repos) => {
          const tx = txOf(repos);
          await tx.$executeRawUnsafe(RENAME, user.id, 'Beto');
          await tx.$executeRawUnsafe(INSERT_EUR, user.id);
          throw error;
        },
        { userLock: user.id },
      ),
    ).rejects.toBe(error);

    expect(await nameOf(user.id)).toBe('Ana');
    expect(await currencyCodes(user.id)).toEqual(['BOB', 'USD']);
  });

  it('TASK-033 un error de la base dentro de fn revierte también las escrituras anteriores', async () => {
    const user = await createUser({ name: 'Ana' });

    await expect(
      uow.run(
        async (repos) => {
          const tx = txOf(repos);
          await tx.$executeRawUnsafe(RENAME, user.id, 'Beto');
          await tx.$executeRawUnsafe(INSERT_EUR, user.id);
          // BOB already exists for every user: the primary key rejects it.
          await tx.$executeRawUnsafe(
            `INSERT INTO currency (user_id, code, symbol) VALUES ($1::uuid, 'BOB', 'Bs')`,
            user.id,
          );
        },
        { userLock: user.id },
      ),
    ).rejects.toThrow();

    expect(await nameOf(user.id)).toBe('Ana');
    expect(await currencyCodes(user.id)).toEqual(['BOB', 'USD']);
  });

  it('TASK-033 un error dentro de fn revierte todo también sin userLock', async () => {
    const user = await createUser({ name: 'Ana' });

    await expect(
      uow.run(async (repos) => {
        await txOf(repos).$executeRawUnsafe(RENAME, user.id, 'Beto');
        throw new AppError('VALIDATION_ERROR');
      }),
    ).rejects.toBeInstanceOf(AppError);

    expect(await nameOf(user.id)).toBe('Ana');
  });
});

describe('UnitOfWork.run con readOnly', () => {
  it('TASK-033 readOnly abre una transacción de solo lectura que permite leer', async () => {
    const user = await createUser({ name: 'Ana' });

    const rows = await uow.run(
      (repos) =>
        txOf(repos).$queryRawUnsafe<{ name: string; readOnly: string }[]>(
          `SELECT name, current_setting('transaction_read_only') AS "readOnly"
             FROM auth_user WHERE id = $1::uuid`,
          user.id,
        ),
      { readOnly: true },
    );

    expect(rows).toEqual([{ name: 'Ana', readOnly: 'on' }]);
  });

  it('TASK-033 readOnly rechaza un UPDATE y no cambia nada', async () => {
    const user = await createUser({ name: 'Ana' });

    await expect(
      uow.run(
        async (repos) => {
          await txOf(repos).$executeRawUnsafe(RENAME, user.id, 'Beto');
        },
        { readOnly: true },
      ),
    ).rejects.toThrow(/read-only transaction/);

    expect(await nameOf(user.id)).toBe('Ana');
  });

  it('TASK-033 readOnly rechaza un INSERT y no crea la fila', async () => {
    const user = await createUser();

    await expect(
      uow.run(
        async (repos) => {
          await txOf(repos).$executeRawUnsafe(INSERT_EUR, user.id);
        },
        { readOnly: true },
      ),
    ).rejects.toThrow(/read-only transaction/);

    expect(await currencyCodes(user.id)).toEqual(['BOB', 'USD']);
  });

  it('TASK-033 sin readOnly la transacción admite escrituras', async () => {
    const user = await createUser();

    const readOnly = await uow.run(async (repos) => {
      const tx = txOf(repos);
      await tx.$executeRawUnsafe(INSERT_EUR, user.id);
      const rows = await tx.$queryRawUnsafe<{ readOnly: string }[]>(
        `SELECT current_setting('transaction_read_only') AS "readOnly"`,
      );
      return rows[0]?.readOnly;
    });

    expect(readOnly).toBe('off');
    expect(await currencyCodes(user.id)).toEqual(['BOB', 'EUR', 'USD']);
  });
});
