import { isReleased, type ModuleKey, type Release } from '@finanzas/contracts';

import type { Clock } from '../ports/clock.js';
import type { JobRuns } from '../ports/job-runs.js';

/**
 * Jobs of the tick in the fixed order of plan §4.0, each with the module that owns it: a job of a
 * module that is not released does not run (ADR-18). `maintenance` serves every module and runs in
 * every release.
 */
const JOBS = [
  { name: 'fx.fetchParallel', module: 'M3' },
  { name: 'fx.fetchOfficial', module: 'M3' },
  { name: 'outbox.send', module: 'M1' },
  { name: 'recurring.generate', module: 'M14' },
  { name: 'budgets.close', module: 'M11' },
  { name: 'budgets.defaultDecision', module: 'M11' },
  { name: 'recurring.expirePending', module: 'M14' },
  { name: 'notifications.scheduled', module: 'M15' },
  { name: 'maintenance', module: null },
] as const satisfies readonly { name: string; module: ModuleKey | null }[];

export type JobName = (typeof JOBS)[number]['name'];

/** One run of a job. It is idempotent: a run cut short is completed by the next one (RNF-13). */
export type JobHandler = () => Promise<void>;

/** After this time the tick starts no more jobs, so it answers in less than 25 s (plan §4.0). */
const TICK_BUDGET_MS = 25_000;

/** Optional per-user scope of a job: the same work restricted to one user (ADR-01). */
export interface JobScope {
  forUser: (userId: string) => Promise<void>;
}

export interface JobsDeps {
  jobRuns: JobRuns;
  clock: Clock;
  release: Release;
}

export interface Jobs {
  /** Registers the run of a job; each module registers its own jobs. */
  registerJob(name: JobName, run: JobHandler, scope?: JobScope): void;
  /**
   * Runs the registered jobs of the released modules once, in the order of plan §4.0. A job whose
   * lease another run holds is skipped. A job that fails is recorded in `job_run` and does not stop
   * the next ones (RNF-13).
   */
  tick(): Promise<void>;
  /**
   * Runs, for one user only, the per-user scope of the registered jobs of the released modules, in
   * the order of plan §4.0. A job that fails does not stop the next ones (RNF-13).
   */
  catchUpUser(userId: string): Promise<void>;
}

const describeError = (error: unknown): string =>
  error instanceof Error ? `${error.name}: ${error.message}` : String(error);

export function createJobs({ jobRuns, clock, release }: JobsDeps): Jobs {
  const handlers = new Map<JobName, JobHandler>();
  const scopes = new Map<JobName, JobScope['forUser']>();

  const runJob = async (name: JobName, run: JobHandler): Promise<void> => {
    if (!(await jobRuns.tryAcquire(name, clock.now()))) return;
    let failure: string | undefined;
    try {
      await run();
    } catch (error) {
      failure = describeError(error);
    }
    await jobRuns.finish(name, clock.now(), failure);
  };

  return {
    registerJob(name, run, scope) {
      if (handlers.has(name)) {
        throw new Error(`The job ${name} is already registered`);
      }
      handlers.set(name, run);
      if (scope !== undefined) {
        scopes.set(name, scope.forUser);
      }
    },

    async catchUpUser(userId) {
      for (const { name, module } of JOBS) {
        const forUser = scopes.get(name);
        if (forUser === undefined || (module !== null && !isReleased(module, release))) continue;
        try {
          await forUser(userId);
        } catch {
          // A failed job does not stop the next ones; the next catch-up or tick completes it.
        }
      }
    },

    async tick() {
      const startedAt = clock.now().getTime();
      for (const { name, module } of JOBS) {
        const run = handlers.get(name);
        if (run === undefined || (module !== null && !isReleased(module, release))) continue;
        if (clock.now().getTime() - startedAt >= TICK_BUDGET_MS) return;
        await runJob(name, run);
      }
    },
  };
}
