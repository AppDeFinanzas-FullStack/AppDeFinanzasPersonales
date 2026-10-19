import type { Instant } from '../../application/ports/clock.js';
import type { JobRuns } from '../../application/ports/job-runs.js';
import type { PrismaClient } from './prisma-client.js';

/**
 * Prisma implementation of the `JobRuns` port: the lease of plan §4.0 in `job_run`. A lease is a
 * row with an expiry, so it works with any connection of the pool or of the pooler; a session
 * advisory lock could be taken and released on different connections and stay taken.
 */
export function createJobRuns(prisma: PrismaClient): JobRuns {
  return {
    async tryAcquire(job: string, now: Instant): Promise<boolean> {
      await prisma.$executeRaw`
        INSERT INTO job_run (job) VALUES (${job})
        ON CONFLICT (job) DO NOTHING`;
      // Concurrent runs serialize on the row: the waiting UPDATE re-checks the condition and no
      // longer matches once another run took the lease.
      const taken = await prisma.$executeRaw`
        UPDATE job_run
           SET locked_until    = ${now}::timestamptz + interval '5 minutes',
               last_started_at = ${now}::timestamptz
         WHERE job = ${job}
           AND (locked_until IS NULL OR locked_until < ${now}::timestamptz)`;
      return taken === 1;
    },

    async finish(job: string, now: Instant, error?: string): Promise<void> {
      await prisma.$executeRaw`
        UPDATE job_run
           SET locked_until     = NULL,
               last_finished_at = ${now}::timestamptz,
               last_error       = ${error ?? null}
         WHERE job = ${job}`;
    },
  };
}
