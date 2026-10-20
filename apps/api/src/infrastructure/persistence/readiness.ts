import type { ReadinessProbe } from '../../application/ports/readiness.js';
import type { PrismaClient } from './prisma-client.js';

/** Limit of the database check (plan §4.2.2). */
const READINESS_TIMEOUT_MS = 2_000;

/**
 * Prisma implementation of the `ReadinessProbe` port: `SELECT 1` on the database, ready only if it
 * answers within the limit. A hanging connection or a failed query both mean not ready.
 */
export function createReadinessProbe(
  prisma: PrismaClient,
  timeoutMs: number = READINESS_TIMEOUT_MS,
): ReadinessProbe {
  return {
    async check(): Promise<boolean> {
      let timer: NodeJS.Timeout | undefined;
      const timeout = new Promise<boolean>((resolve) => {
        timer = setTimeout(() => {
          resolve(false);
        }, timeoutMs);
      });
      const query = prisma.$queryRaw`SELECT 1`.then(
        () => true,
        () => false,
      );
      try {
        return await Promise.race([query, timeout]);
      } finally {
        clearTimeout(timer);
      }
    },
  };
}
