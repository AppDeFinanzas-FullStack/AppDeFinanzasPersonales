import { createPrismaClient, type PrismaClient } from '@finanzas/db';

import type { QueryCounter } from '../../application/ports/query-counter.js';
import type { Env } from '../config/env.js';

export { forUser, type PrismaClient, type ScopedPrismaClient } from '@finanzas/db';

/**
 * The API's single Prisma client, built from the validated env. The composition root creates it
 * once and every user-scoped access wraps it with `forUser` (ADR-05).
 *
 * Prisma's `$disconnect` waits for a connection attempt in flight and rejects with its error when
 * the database is unreachable (for example after the readiness probe gave up on it, plan §4.2.2).
 * Shutting down never depends on the database answering: once that attempt has failed there is no
 * connection left, so a second `$disconnect` just closes the client.
 */
export const buildPrismaClient = (
  env: Pick<Env, 'DATABASE_URL'> & Partial<Pick<Env, 'DB_LATENCY_MS'>>,
  counter?: QueryCounter,
): PrismaClient => {
  const prisma = createPrismaClient(env.DATABASE_URL, {
    latencyMs: env.DB_LATENCY_MS ?? 0,
    ...(counter === undefined ? {} : { onOperation: (ms: number) => counter.record(ms) }),
  });
  const disconnect = prisma.$disconnect.bind(prisma);
  prisma.$disconnect = async (): Promise<void> => {
    try {
      await disconnect();
    } catch {
      await disconnect();
    }
  };
  return prisma;
};
