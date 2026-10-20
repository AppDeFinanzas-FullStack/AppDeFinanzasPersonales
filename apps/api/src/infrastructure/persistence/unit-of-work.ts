import type { Repositories } from '../../application/ports/repositories.js';
import type { UnitOfWork, UnitOfWorkOptions } from '../../application/ports/unit-of-work.js';
import { forUser, type PrismaClient, type ScopedPrismaClient } from './prisma-client.js';

/**
 * Client of one interactive transaction. When the run locks a user, its model queries go through
 * the isolation extension of that user (ADR-05).
 */
export type TransactionClient = Parameters<Parameters<ScopedPrismaClient['$transaction']>[0]>[0];

/**
 * Builds the repositories of one transaction, bound to its client and to the locked user
 * (`undefined` when the run locks none). It may build only part of the set. Repositories never open transactions (plan §1.4).
 */
export type BuildRepositories = (
  tx: TransactionClient,
  userId: string | undefined,
) => Partial<Repositories>;

/** Per-user lock (RNF-10). Postgres releases it when the transaction commits or rolls back. */
async function lockUser(tx: TransactionClient, userId: string): Promise<void> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('user:' || ${userId}::text))`;
}

/**
 * Prisma implementation of the `UnitOfWork` port (plan §1.4, §4.0). Each `run` opens an
 * interactive transaction: `readOnly` makes it read-only before any other statement, and
 * `userLock` takes that user's advisory lock and scopes the client to the user. An error inside
 * `fn` rolls everything back and reaches the caller unchanged.
 */
export function createUnitOfWork(
  prisma: PrismaClient,
  buildRepositories: BuildRepositories,
): UnitOfWork {
  // Same client type as `forUser`'s, without any user filter, for runs that lock no user.
  const unscoped = prisma.$extends({ name: 'unscoped' });

  return {
    run<T>(fn: (repos: Repositories) => Promise<T>, opts: UnitOfWorkOptions = {}): Promise<T> {
      const { userLock, readOnly = false } = opts;
      const client = userLock === undefined ? unscoped : forUser(prisma, userLock);
      return client.$transaction(async (tx) => {
        if (readOnly) {
          await tx.$executeRaw`SET TRANSACTION READ ONLY`;
        }
        if (userLock !== undefined) {
          await lockUser(tx, userLock);
        }
        // The composition root builds the full set; callers that build a part never read the rest.
        return fn(buildRepositories(tx, userLock) as Repositories);
      });
    },
  };
}
