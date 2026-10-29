import { afterAll, describe, expect, it } from 'vitest';

import type { Repositories } from '../../src/application/ports/repositories.js';
import type { UnitOfWork } from '../../src/application/ports/unit-of-work.js';
import {
  createUnitOfWork,
  type TransactionClient,
} from '../../src/infrastructure/persistence/unit-of-work.js';
import { createUser, deleteCreatedUsers } from '../factories/user.factory.js';
import { disconnectTestPrisma, testPrisma } from './setup/db.js';

/**
 * TASK-256: a `readOnly` run of the UnitOfWork keeps scoping the repositories to the user
 * (RNF-14) but no longer takes the per-user advisory lock (RNF-10) and runs in REPEATABLE READ
 * (RNF-29). The probe exposes the transaction client of each run, scoped to the locked user.
 */
interface ProbeRepositories {
  tx: TransactionClient;
}

const buildProbeRepositories = (tx: TransactionClient): Repositories =>
  Object.assign(Object.create(null) as Repositories, { tx });

const uow: UnitOfWork = createUnitOfWork(testPrisma(), buildProbeRepositories);

const txOf = (repos: Repositories): TransactionClient => (repos as unknown as ProbeRepositories).tx;

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

/** Lets `run` settle against a deadline and reports who won. */
const settlesWithin = <T>(run: Promise<T>, ms: number, fallback: string): Promise<T | string> =>
  Promise.race([run, sleep(ms).then(() => fallback)]);

/** Whether the per-user lock is free, asked from another connection without waiting. */
async function userLockIsFree(userId: string): Promise<boolean> {
  const rows = await testPrisma().$queryRaw<{ free: boolean }[]>`
    SELECT pg_try_advisory_xact_lock(hashtext('user:' || ${userId}::text)) AS free`;
  return rows[0]?.free ?? false;
}

/** Inserts a currency of the user from another connection and commits it. */
async function insertCurrency(userId: string, code: string): Promise<void> {
  await testPrisma().$executeRaw`
    INSERT INTO currency (user_id, code, symbol) VALUES (${userId}::uuid, ${code}, '¤')`;
}

async function nameOf(userId: string): Promise<string | undefined> {
  const rows = await testPrisma().$queryRaw<{ name: string }[]>`
    SELECT name FROM auth_user WHERE id = ${userId}::uuid`;
  return rows[0]?.name;
}

// ---------- Tests ----------

describe('lecturas del UnitOfWork sin bloqueo exclusivo por usuario', () => {
  it('RNF-10 una lectura del usuario termina mientras una escritura del mismo usuario retiene el bloqueo', async () => {
    const user = await createUser();
    const writerEntered = deferred();
    const releaseWriter = deferred();

    const writer = uow.run(
      async () => {
        writerEntered.resolve();
        await releaseWriter.promise;
      },
      { userLock: user.id },
    );
    let reader: Promise<string> | undefined;
    try {
      await writerEntered.promise;
      expect(await userLockIsFree(user.id)).toBe(false);

      reader = uow.run(() => Promise.resolve('lectura terminó'), {
        userLock: user.id,
        readOnly: true,
      });

      const winner = await settlesWithin(reader, PARALLEL_LIMIT_MS, 'lectura sigue esperando');
      expect(winner).toBe('lectura terminó');
    } finally {
      releaseWriter.resolve();
      await Promise.allSettled([writer, reader]);
    }
  });

  it('RNF-10 dos lecturas del mismo usuario corren a la vez: la segunda no espera a que termine la primera', async () => {
    const user = await createUser();
    const firstEntered = deferred();
    const releaseFirst = deferred();

    const first = uow.run(
      async () => {
        firstEntered.resolve();
        await releaseFirst.promise;
      },
      { userLock: user.id, readOnly: true },
    );
    let second: Promise<string> | undefined;
    try {
      await firstEntered.promise;
      second = uow.run(() => Promise.resolve('B terminó'), {
        userLock: user.id,
        readOnly: true,
      });

      const winner = await settlesWithin(second, PARALLEL_LIMIT_MS, 'B sigue esperando');
      expect(winner).toBe('B terminó');
    } finally {
      releaseFirst.resolve();
      await Promise.allSettled([first, second]);
    }
  });

  it('RNF-10 una lectura con userLock no toma el advisory lock del usuario', async () => {
    const user = await createUser();

    const freeWhileReading = await uow.run(() => userLockIsFree(user.id), {
      userLock: user.id,
      readOnly: true,
    });

    expect(freeWhileReading).toBe(true);
  });

  it('RNF-10 una escritura del mismo usuario no espera a una lectura en curso', async () => {
    const user = await createUser({ name: 'Ana' });
    const readerEntered = deferred();
    const releaseReader = deferred();

    const reader = uow.run(
      async () => {
        readerEntered.resolve();
        await releaseReader.promise;
      },
      { userLock: user.id, readOnly: true },
    );
    let writer: Promise<string> | undefined;
    try {
      await readerEntered.promise;
      writer = uow.run(() => Promise.resolve('escritura terminó'), { userLock: user.id });

      const winner = await settlesWithin(writer, PARALLEL_LIMIT_MS, 'escritura sigue esperando');
      expect(winner).toBe('escritura terminó');
    } finally {
      releaseReader.resolve();
      await Promise.allSettled([reader, writer]);
    }
  });

  it('RNF-10 dos escrituras del mismo usuario siguen haciendo cola aunque haya una lectura en curso', async () => {
    const user = await createUser();
    const events: string[] = [];
    const firstEntered = deferred();
    const releaseFirst = deferred();

    const first = uow.run(
      async () => {
        events.push('W1:start');
        firstEntered.resolve();
        await releaseFirst.promise;
        events.push('W1:end');
      },
      { userLock: user.id },
    );
    let second: Promise<void> | undefined;
    let reader: Promise<string> | undefined;
    try {
      await firstEntered.promise;
      second = uow.run(
        () => {
          events.push('W2:start');
          return Promise.resolve();
        },
        { userLock: user.id },
      );
      reader = uow.run(() => Promise.resolve('lectura'), { userLock: user.id, readOnly: true });
      expect(await settlesWithin(reader, PARALLEL_LIMIT_MS, 'lectura sigue esperando')).toBe(
        'lectura',
      );
      await sleep(BLOCKED_WINDOW_MS);
      expect(events).toEqual(['W1:start']);

      releaseFirst.resolve();
      await Promise.all([first, second]);
      expect(events).toEqual(['W1:start', 'W1:end', 'W2:start']);
    } finally {
      releaseFirst.resolve();
      await Promise.allSettled([first, second, reader]);
    }
  });

  it('RNF-29 una lectura de dos sentencias no ve las filas que otra transacción confirma entre ambas', async () => {
    const user = await createUser();
    const [before, after] = await uow.run(
      async (repos) => {
        const tx = txOf(repos);
        const first = await tx.currency.count();
        await insertCurrency(user.id, 'EUR');
        const second = await tx.currency.count();
        return [first, second] as const;
      },
      { userLock: user.id, readOnly: true },
    );

    expect(before).toBe(2);
    expect(after).toBe(2);
    // A new read does see the committed row.
    const fresh = await uow.run((repos) => txOf(repos).currency.count(), {
      userLock: user.id,
      readOnly: true,
    });
    expect(fresh).toBe(3);
  });

  it('RNF-29 una lectura sin userLock también ve una sola foto de la base entre sus sentencias', async () => {
    const user = await createUser();

    const [before, after] = await uow.run(
      async (repos) => {
        const tx = txOf(repos);
        const count = () =>
          tx.$queryRaw<{ total: number }[]>`
            SELECT count(*)::int AS total FROM currency WHERE user_id = ${user.id}::uuid`.then(
            (rows) => rows[0]?.total ?? -1,
          );
        const first = await count();
        await insertCurrency(user.id, 'EUR');
        const second = await count();
        return [first, second] as const;
      },
      { readOnly: true },
    );

    expect(before).toBe(2);
    expect(after).toBe(2);
  });

  it('RNF-29 una escritura sin readOnly sigue en READ COMMITTED: ve lo que otra transacción confirma', async () => {
    const user = await createUser();

    const [before, after] = await uow.run(
      async (repos) => {
        const tx = txOf(repos);
        const first = await tx.currency.count();
        await insertCurrency(user.id, 'EUR');
        const second = await tx.currency.count();
        return [first, second] as const;
      },
      { userLock: user.id },
    );

    expect(before).toBe(2);
    expect(after).toBe(3);
  });
});

describe('lecturas del UnitOfWork acotadas al usuario', () => {
  it('RNF-14 una lectura con userLock solo ve las filas de su usuario', async () => {
    const [ana, beto] = await Promise.all([createUser(), createUser()]);
    await insertCurrency(beto.id, 'EUR');

    const seen = await uow.run(
      async (repos) => {
        const tx = txOf(repos);
        const own = await tx.currency.findMany({ orderBy: { code: 'asc' } });
        const foreign = await tx.currency.findMany({ where: { userId: beto.id } });
        return { own, foreign };
      },
      { userLock: ana.id, readOnly: true },
    );

    expect(seen.own.map((row) => row.code)).toEqual(['BOB', 'USD']);
    expect(seen.own.every((row) => row.userId === ana.id)).toBe(true);
    expect(seen.foreign).toEqual([]);
  });

  it('RNF-14 una lectura con userLock no puede escribir con el cliente del repositorio', async () => {
    const user = await createUser();

    await expect(
      uow.run(
        async (repos) => {
          await txOf(repos).currency.create({
            data: { userId: user.id, code: 'EUR', symbol: '€' },
          });
        },
        { userLock: user.id, readOnly: true },
      ),
    ).rejects.toThrow(/read-only transaction/);

    const rows = await testPrisma().$queryRaw<{ code: string }[]>`
      SELECT code FROM currency WHERE user_id = ${user.id}::uuid ORDER BY code`;
    expect(rows.map((row) => row.code)).toEqual(['BOB', 'USD']);
  });

  it('RNF-14 una lectura con userLock rechaza un UPDATE crudo y no cambia nada', async () => {
    const user = await createUser({ name: 'Ana' });

    await expect(
      uow.run(
        async (repos) => {
          await txOf(repos).$executeRaw`
            UPDATE auth_user SET name = 'Beto' WHERE id = ${user.id}::uuid`;
        },
        { userLock: user.id, readOnly: true },
      ),
    ).rejects.toThrow(/read-only transaction/);

    expect(await nameOf(user.id)).toBe('Ana');
  });
});
