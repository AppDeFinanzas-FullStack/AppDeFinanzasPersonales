import type { Instant } from './clock.js';

/**
 * Runs of the tick's jobs in `job_run` (plan §4.0, plan §3.7). Each job holds a lease while it
 * runs, so two runs never execute the same job at once and a run that dies frees it on its own.
 */
export interface JobRuns {
  /**
   * Takes the job's lease at `now` and records the start. Returns false, without touching the
   * job, when another run holds a lease in force.
   */
  tryAcquire(job: string, now: Instant): Promise<boolean>;

  /** Releases the job's lease and records the end and the error of the run, if it failed. */
  finish(job: string, now: Instant, error?: string): Promise<void>;
}
