import type { Release } from '@finanzas/contracts';
import type { Express } from 'express';
import request from 'supertest';
import { uuidv7 } from 'uuidv7';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { createJobs } from '../../src/application/jobs/tick.js';
import type { Clock } from '../../src/application/ports/clock.js';
import type { JobRuns } from '../../src/application/ports/job-runs.js';
import { buildContainer, createApp } from '../../src/composition/container.js';
import { parseEnv } from '../../src/infrastructure/config/env.js';
import { createJobRuns } from '../../src/infrastructure/persistence/job-runs.js';
import { disconnectTestPrisma, testDatabaseUrl, testPrisma } from './setup/db.js';

/**
 * The plan fixes the `JobRuns` port (`tryAcquire(job, now)` and `finish(job, now, error?)`), the
 * lease in `job_run`, the names and order of the jobs and `registerJob(name, run)` (plan §4.0), but
 * not how the lease and the tick are built. These tests use:
 * - `createJobRuns(prisma)`: the Prisma implementation of `JobRuns`;
 * - `createJobs({ jobRuns, clock, release })`: the job registry of the tick, with
 *   `registerJob(name, run)` for the modules and `tick()`, which runs the registered jobs once.
 * The tick takes the time from its `Clock`: the `now` of each lease and the 25 s budget.
 * A job's `run` is a function that returns a promise; these probes take no arguments.
 */
const jobRuns: JobRuns = createJobRuns(testPrisma());

/** Jobs of the tick, in the order of plan §4.0. */
const PLAN_ORDER = [
  'fx.fetchParallel',
  'fx.fetchOfficial',
  'outbox.send',
  'recurring.generate',
  'budgets.close',
  'budgets.defaultDecision',
  'recurring.expirePending',
  'notifications.scheduled',
  'maintenance',
] as const;

type PlanJob = (typeof PLAN_ORDER)[number];

/** Lease length (plan §4.0): `locked_until = now + 5 min`. */
const LEASE_MS = 5 * 60_000;

/** Time after which the tick stops starting jobs. */
const TICK_BUDGET_MS = 25_000;

// ---------- Helpers ----------

/** Start of every test, in whole seconds so it round-trips through timestamptz unchanged. */
const t0 = new Date(Math.floor(Date.now() / 1000) * 1000);

/** Instant `ms` milliseconds after (or before, if negative) `t0`. */
const at = (ms: number) => new Date(t0.getTime() + ms);

interface FakeClock extends Clock {
  advance(ms: number): void;
}

/** Clock that stays still until a test moves it forward. */
function fakeClock(start: Date = t0): FakeClock {
  let current = start.getTime();
  return {
    now: () => new Date(current),
    todayFor: () => new Date(current).toISOString().slice(0, 10),
    advance: (ms) => {
      current += ms;
    },
  };
}

const sleep = (ms: number) =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });

interface JobRunRow {
  job: string;
  lastStartedAt: Date | null;
  lastFinishedAt: Date | null;
  lastError: string | null;
  lockedUntil: Date | null;
}

/** The `job_run` row of a job, read outside of the code under test. */
async function jobRunRow(job: string): Promise<JobRunRow | undefined> {
  const rows = await testPrisma().$queryRaw<JobRunRow[]>`
    SELECT job,
           last_started_at  AS "lastStartedAt",
           last_finished_at AS "lastFinishedAt",
           last_error       AS "lastError",
           locked_until     AS "lockedUntil"
      FROM job_run WHERE job = ${job}`;
  return rows[0];
}

/** Every `job_run` row, to show that a request changed nothing. */
async function allJobRunRows(): Promise<JobRunRow[]> {
  return testPrisma().$queryRaw<JobRunRow[]>`
    SELECT job,
           last_started_at  AS "lastStartedAt",
           last_finished_at AS "lastFinishedAt",
           last_error       AS "lastError",
           locked_until     AS "lockedUntil"
      FROM job_run ORDER BY job`;
}

/** Leaves a `job_run` row as another run (alive or dead) would have left it. */
async function seedJobRun(
  job: string,
  row: { lastStartedAt: Date | null; lockedUntil: Date | null },
): Promise<void> {
  await testPrisma().$executeRaw`
    INSERT INTO job_run (job, last_started_at, locked_until)
    VALUES (${job}, ${row.lastStartedAt}::timestamptz, ${row.lockedUntil}::timestamptz)`;
}

/** Advisory locks held right now in the test database, by any connection. */
async function advisoryLocksHeld(): Promise<number> {
  const rows = await testPrisma().$queryRaw<{ count: number }[]>`
    SELECT count(*)::int AS count
      FROM pg_locks
     WHERE locktype = 'advisory'
       AND database = (SELECT oid FROM pg_database WHERE datname = current_database())`;
  return rows[0]?.count ?? 0;
}

const createdTestJobs: string[] = [];

/** A job name of its own for each port test, so no test sees another one's row. */
function testJob(): string {
  const job = `test.lease.${uuidv7()}`;
  createdTestJobs.push(job);
  return job;
}

async function deleteJobRuns(jobs: readonly string[]): Promise<void> {
  if (jobs.length > 0) {
    await testPrisma().$executeRaw`DELETE FROM job_run WHERE job = ANY(${[...jobs]}::text[])`;
  }
}

/** Probes that record, in order, which jobs ran. */
function recorder() {
  const calls: string[] = [];
  const job =
    (name: string, body?: () => Promise<void>) =>
    async (): Promise<void> => {
      calls.push(name);
      if (body) await body();
    };
  return { calls, job };
}

function jobsFor(release: Release, clock: Clock = fakeClock()) {
  return createJobs({ jobRuns, clock, release });
}

type Jobs = ReturnType<typeof jobsFor>;

/** Registers a recording probe for every job of the plan, in the given order. */
function registerAll(
  jobs: Jobs,
  probe: ReturnType<typeof recorder>,
  order: readonly PlanJob[] = PLAN_ORDER,
): void {
  for (const name of order) {
    jobs.registerJob(name, probe.job(name));
  }
}

/** Runs a tick whose result the plan does not fix when a job fails: only its effects count. */
async function tickIgnoringOutcome(jobs: Jobs): Promise<void> {
  try {
    await jobs.tick();
  } catch {
    // Whether the tick reports a failed job is not fixed by the plan.
  }
}

beforeEach(async () => {
  await deleteJobRuns(PLAN_ORDER);
});

afterAll(async () => {
  await deleteJobRuns([...PLAN_ORDER, ...createdTestJobs]);
  await disconnectTestPrisma();
});

// ---------- JobRuns: the lease in job_run ----------

describe('JobRuns.tryAcquire', () => {
  it('TASK-038 tryAcquire de un job sin fila crea la fila, devuelve true y toma el lease por 5 minutos', async () => {
    const job = testJob();

    const acquired = await jobRuns.tryAcquire(job, t0);

    expect(acquired).toBe(true);
    const row = await jobRunRow(job);
    expect(row?.lockedUntil).toEqual(at(LEASE_MS));
    expect(row?.lastStartedAt).toEqual(t0);
  });

  it('TASK-038 con el lease vigente, tryAcquire devuelve false y no toca la fila', async () => {
    const job = testJob();
    expect(await jobRuns.tryAcquire(job, t0)).toBe(true);

    const second = await jobRuns.tryAcquire(job, at(60_000));

    expect(second).toBe(false);
    const row = await jobRunRow(job);
    expect(row?.lockedUntil).toEqual(at(LEASE_MS));
    expect(row?.lastStartedAt).toEqual(t0);
  });

  it('RNF-13 el lease de una corrida que murió vence a los 5 minutos y otra corrida lo toma', async () => {
    const job = testJob();
    expect(await jobRuns.tryAcquire(job, t0)).toBe(true);

    expect(await jobRuns.tryAcquire(job, at(LEASE_MS - 1_000))).toBe(false);

    const later = at(LEASE_MS + 1_000);
    expect(await jobRuns.tryAcquire(job, later)).toBe(true);
    const row = await jobRunRow(job);
    expect(row?.lastStartedAt).toEqual(later);
    expect(row?.lockedUntil).toEqual(new Date(later.getTime() + LEASE_MS));
  });

  it('RNF-13 dos tryAcquire simultáneos del mismo job: solo uno toma el lease', async () => {
    const job = testJob();

    const results = await Promise.all(
      Array.from({ length: 5 }, () => jobRuns.tryAcquire(job, t0)),
    );

    expect(results.filter(Boolean)).toHaveLength(1);
  });

  it('TASK-038 tryAcquire no deja advisory locks de sesión tomados', async () => {
    const job = testJob();

    expect(await jobRuns.tryAcquire(job, t0)).toBe(true);

    expect(await advisoryLocksHeld()).toBe(0);
  });
});

describe('JobRuns.finish', () => {
  it('TASK-038 finish sin error vuelve locked_until a NULL, registra el fin y el job se puede volver a tomar', async () => {
    const job = testJob();
    expect(await jobRuns.tryAcquire(job, t0)).toBe(true);

    await jobRuns.finish(job, at(2_000));

    const row = await jobRunRow(job);
    expect(row?.lockedUntil).toBeNull();
    expect(row?.lastFinishedAt).toEqual(at(2_000));
    expect(row?.lastError).toBeNull();
    expect(row?.lastStartedAt).toEqual(t0);
    expect(await jobRuns.tryAcquire(job, at(3_000))).toBe(true);
  });

  it('RNF-13 finish con error vuelve locked_until a NULL y registra el fin y last_error', async () => {
    const job = testJob();
    expect(await jobRuns.tryAcquire(job, t0)).toBe(true);

    await jobRuns.finish(job, at(2_000), 'outbox provider down');

    const row = await jobRunRow(job);
    expect(row?.lockedUntil).toBeNull();
    expect(row?.lastFinishedAt).toEqual(at(2_000));
    expect(row?.lastError).toContain('outbox provider down');
    expect(await jobRuns.tryAcquire(job, at(3_000))).toBe(true);
  });
});

// ---------- The tick ----------

describe('tick: orden de los jobs', () => {
  it('TASK-038 los jobs corren en el orden del plan aunque se registren en otro orden', async () => {
    const jobs = jobsFor('1.2');
    const probe = recorder();
    registerAll(jobs, probe, [...PLAN_ORDER].reverse());

    await jobs.tick();

    expect(probe.calls).toEqual([...PLAN_ORDER]);
  });

  it('TASK-038 con algunos jobs registrados, corren solo esos y en el orden del plan', async () => {
    const jobs = jobsFor('1.2');
    const probe = recorder();
    registerAll(jobs, probe, ['maintenance', 'outbox.send', 'fx.fetchParallel']);

    await jobs.tick();

    expect(probe.calls).toEqual(['fx.fetchParallel', 'outbox.send', 'maintenance']);
  });
});

describe('tick: lease de cada job', () => {
  it('TASK-038 un job con un lease vigente se salta, su fila queda intacta y los siguientes corren', async () => {
    await seedJobRun('outbox.send', { lastStartedAt: at(-3 * 60_000), lockedUntil: at(2 * 60_000) });
    const jobs = jobsFor('1.0');
    const probe = recorder();
    registerAll(jobs, probe, ['fx.fetchParallel', 'outbox.send', 'maintenance']);

    await jobs.tick();

    expect(probe.calls).toEqual(['fx.fetchParallel', 'maintenance']);
    const row = await jobRunRow('outbox.send');
    expect(row?.lockedUntil).toEqual(at(2 * 60_000));
    expect(row?.lastStartedAt).toEqual(at(-3 * 60_000));
    expect(row?.lastFinishedAt).toBeNull();
  });

  it('RNF-13 un job con el lease vencido (la corrida anterior murió) se toma y corre', async () => {
    await seedJobRun('outbox.send', { lastStartedAt: at(-6 * 60_000), lockedUntil: at(-60_000) });
    const jobs = jobsFor('1.0');
    const probe = recorder();
    registerAll(jobs, probe, ['outbox.send']);

    await jobs.tick();

    expect(probe.calls).toEqual(['outbox.send']);
    const row = await jobRunRow('outbox.send');
    expect(row?.lastStartedAt).toEqual(t0);
    expect(row?.lastFinishedAt).toEqual(t0);
    expect(row?.lockedUntil).toBeNull();
  });

  it('TASK-038 mientras corre, el job tiene su lease: locked_until = now + 5 min y last_started_at = now', async () => {
    const jobs = jobsFor('1.0');
    let during: JobRunRow | undefined;
    jobs.registerJob('maintenance', async () => {
      during = await jobRunRow('maintenance');
    });

    await jobs.tick();

    expect(during?.lockedUntil).toEqual(at(LEASE_MS));
    expect(during?.lastStartedAt).toEqual(t0);
  });

  it('TASK-038 al terminar con éxito, locked_until queda en NULL y last_finished_at registrado', async () => {
    const clock = fakeClock();
    const jobs = jobsFor('1.0', clock);
    jobs.registerJob('maintenance', () => {
      clock.advance(3_000);
      return Promise.resolve();
    });

    await jobs.tick();

    const row = await jobRunRow('maintenance');
    expect(row?.lockedUntil).toBeNull();
    expect(row?.lastStartedAt).toEqual(t0);
    expect(row?.lastFinishedAt).toEqual(at(3_000));
    expect(row?.lastError).toBeNull();
  });

  it('TASK-038 mientras corre un job no hay advisory locks de sesión tomados', async () => {
    const jobs = jobsFor('1.0');
    let locksDuringRun: number | undefined;
    jobs.registerJob('maintenance', async () => {
      locksDuringRun = await advisoryLocksHeld();
    });

    await jobs.tick();

    expect(locksDuringRun).toBe(0);
    expect(await advisoryLocksHeld()).toBe(0);
  });
});

describe('tick: un job que falla', () => {
  it('RNF-13 un job que falla registra last_error, libera su lease y no detiene los siguientes', async () => {
    const jobs = jobsFor('1.0');
    const probe = recorder();
    jobs.registerJob('fx.fetchParallel', probe.job('fx.fetchParallel'));
    jobs.registerJob(
      'outbox.send',
      probe.job('outbox.send', () => Promise.reject(new Error('outbox provider down'))),
    );
    jobs.registerJob('maintenance', probe.job('maintenance'));

    await tickIgnoringOutcome(jobs);

    expect(probe.calls).toEqual(['fx.fetchParallel', 'outbox.send', 'maintenance']);
    const failed = await jobRunRow('outbox.send');
    expect(failed?.lastError).toContain('outbox provider down');
    expect(failed?.lockedUntil).toBeNull();
    expect(failed?.lastFinishedAt).toEqual(t0);
    const next = await jobRunRow('maintenance');
    expect(next?.lastError).toBeNull();
    expect(next?.lockedUntil).toBeNull();
    expect(next?.lastFinishedAt).toEqual(t0);
  });

  it('RNF-13 después de un job que falló, el siguiente tick lo vuelve a tomar', async () => {
    const failing = jobsFor('1.0');
    failing.registerJob('outbox.send', () => Promise.reject(new Error('outbox provider down')));
    await tickIgnoringOutcome(failing);

    const retry = jobsFor('1.0', fakeClock(at(60_000)));
    const probe = recorder();
    registerAll(retry, probe, ['outbox.send']);
    await retry.tick();

    expect(probe.calls).toEqual(['outbox.send']);
    const row = await jobRunRow('outbox.send');
    expect(row?.lastStartedAt).toEqual(at(60_000));
    expect(row?.lockedUntil).toBeNull();
  });
});

describe('tick: dos corridas a la vez', () => {
  it('RNF-13 dos ticks en paralelo nunca corren el mismo job a la vez y no omiten ninguno', async () => {
    const running = new Map<string, number>();
    const maxRunning = new Map<string, number>();
    const runs = new Map<string, number>();
    const tracked = (name: string) => async (): Promise<void> => {
      const now = (running.get(name) ?? 0) + 1;
      running.set(name, now);
      maxRunning.set(name, Math.max(maxRunning.get(name) ?? 0, now));
      runs.set(name, (runs.get(name) ?? 0) + 1);
      await sleep(50);
      running.set(name, (running.get(name) ?? 1) - 1);
    };
    const first = jobsFor('1.2');
    const second = jobsFor('1.2');
    for (const name of PLAN_ORDER) {
      first.registerJob(name, tracked(name));
      second.registerJob(name, tracked(name));
    }

    await Promise.all([first.tick(), second.tick()]);

    for (const name of PLAN_ORDER) {
      expect(runs.get(name) ?? 0, name).toBeGreaterThanOrEqual(1);
      expect(maxRunning.get(name), name).toBe(1);
    }
  });
});

describe('tick: límite de 25 s', () => {
  it('TASK-038 el tick deja de iniciar jobs al pasar los 25 s', async () => {
    const clock = fakeClock();
    const jobs = jobsFor('1.2', clock);
    const probe = recorder();
    jobs.registerJob(
      'fx.fetchParallel',
      probe.job('fx.fetchParallel', () => {
        clock.advance(TICK_BUDGET_MS + 1_000);
        return Promise.resolve();
      }),
    );
    registerAll(jobs, probe, PLAN_ORDER.slice(1));

    await jobs.tick();

    expect(probe.calls).toEqual(['fx.fetchParallel']);
    expect((await jobRunRow('fx.fetchParallel'))?.lockedUntil).toBeNull();
  });

  it('TASK-038 antes de los 25 s el tick sigue iniciando jobs', async () => {
    const clock = fakeClock();
    const jobs = jobsFor('1.2', clock);
    const probe = recorder();
    jobs.registerJob(
      'fx.fetchParallel',
      probe.job('fx.fetchParallel', () => {
        clock.advance(TICK_BUDGET_MS - 1_000);
        return Promise.resolve();
      }),
    );
    registerAll(jobs, probe, PLAN_ORDER.slice(1));

    await jobs.tick();

    expect(probe.calls).toEqual([...PLAN_ORDER]);
  });
});

describe('tick: jobs de módulos no liberados (ADR-18)', () => {
  it('TASK-038 con RELEASE=1.0 no corren los jobs de presupuestos (M11), recurrentes (M14) ni avisos (M15)', async () => {
    const jobs = jobsFor('1.0');
    const probe = recorder();
    registerAll(jobs, probe);

    await jobs.tick();

    expect(probe.calls).toEqual(['fx.fetchParallel', 'fx.fetchOfficial', 'outbox.send', 'maintenance']);
  });

  it('TASK-038 con RELEASE=1.1 corren los de presupuestos y avisos, y no los de recurrentes (M14)', async () => {
    const jobs = jobsFor('1.1');
    const probe = recorder();
    registerAll(jobs, probe);

    await jobs.tick();

    expect(probe.calls).toEqual([
      'fx.fetchParallel',
      'fx.fetchOfficial',
      'outbox.send',
      'budgets.close',
      'budgets.defaultDecision',
      'notifications.scheduled',
      'maintenance',
    ]);
  });
});

// ---------- POST /internal/jobs/tick ----------

const TICK_PATH = '/internal/jobs/tick';
const JOBS_SECRET = 'jobs-secret-for-the-tick-test';

const envSource = (): Record<string, string> => ({
  NODE_ENV: 'test',
  PORT: '3000',
  DATABASE_URL: testDatabaseUrl(),
  AUTH_SECRET: 'auth-secret-for-the-tick-test',
  HMAC_SECRET: 'hmac-secret-for-the-tick-test',
  JOBS_SECRET,
  RESEND_API_KEY: 'resend-key-for-the-tick-test',
  RELEASE: '1.0',
  WEB_ORIGIN: 'http://localhost:5173',
  INTEGRATIONS: 'fake',
});

describe('POST /internal/jobs/tick', () => {
  // The plan does not fix whether building the container or the app is synchronous.
  let container: Awaited<ReturnType<typeof buildContainer>> | undefined;
  let app: Express | undefined;

  beforeAll(async () => {
    container = await Promise.resolve(buildContainer(parseEnv(envSource())));
    app = await Promise.resolve(createApp(container));
  });

  afterAll(async () => {
    await container?.prisma.$disconnect();
  });

  /** A JSON POST, as a mutation must be (`requireJson`), with or without the secret. */
  const postTick = (secret?: string) => {
    if (app === undefined) throw new Error('the app was not built');
    const req = request(app).post(TICK_PATH).set('Content-Type', 'application/json');
    return (secret === undefined ? req : req.set('x-jobs-secret', secret)).send({});
  };

  it('TASK-038 sin el encabezado x-jobs-secret responde 404 y no corre ningún job', async () => {
    const before = await allJobRunRows();

    const res = await postTick();

    expect(res.status).toBe(404);
    expect(await allJobRunRows()).toEqual(before);
  });

  it('TASK-038 con un x-jobs-secret incorrecto responde 404 y no corre ningún job', async () => {
    const before = await allJobRunRows();

    const res = await postTick('not-the-jobs-secret');

    expect(res.status).toBe(404);
    expect(res.text).not.toContain(JOBS_SECRET);
    expect(await allJobRunRows()).toEqual(before);
  });

  it('TASK-038 con el x-jobs-secret correcto el tick corre y responde 2xx', async () => {
    const res = await postTick(JOBS_SECRET);

    expect(res.status, res.text).toBeGreaterThanOrEqual(200);
    expect(res.status, res.text).toBeLessThan(300);
  });
});
