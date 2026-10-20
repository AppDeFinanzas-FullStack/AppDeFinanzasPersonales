import express, { type RequestHandler } from 'express';
import request from 'supertest';
import { afterAll, describe, expect, it } from 'vitest';

import { createJobs } from '../../src/application/jobs/tick.js';
import type { Clock } from '../../src/application/ports/clock.js';
import { createJobRuns } from '../../src/infrastructure/persistence/job-runs.js';
import { catchUp } from '../../src/presentation/middlewares/catch-up.js';
import { disconnectTestPrisma, testPrisma } from './setup/db.js';

/**
 * The plan (§4.0, ADR-01) fixes that the first authenticated request of each user in their local
 * day runs `catchUpUser(userId)` (the registered jobs that have a per-user scope) without blocking
 * the response, but not the signatures. These tests use:
 * - `jobs.registerJob(name, run, { forUser })`: the optional third argument gives the job a
 *   per-user scope; `forUser(userId)` returns a promise. A job without it has no per-user scope;
 * - `jobs.catchUpUser(userId)`: runs the `forUser` of the registered jobs of the released modules,
 *   in the order of plan §4.0, for that user only;
 * - `catchUp({ jobs, clock })`: Express middleware that runs after `requireSession`. It reads
 *   `req.auth = { userId, timezone }`, takes the local day from `clock.todayFor(timezone)`, keeps
 *   in memory the (user, day) pairs already done, calls `jobs.catchUpUser(userId)` at most once per
 *   pair without waiting for it, and always calls `next()`.
 */

afterAll(async () => {
  await disconnectTestPrisma();
});

const fixedClock = (): Clock => ({
  now: () => new Date('2026-10-19T12:00:00Z'),
  todayFor: () => '2026-10-19',
});

// ---------- catchUpUser on the job registry ----------

describe('Jobs.catchUpUser', () => {
  it('RNF-13 catchUpUser corre solo los jobs con alcance por usuario, en el orden del plan y con el userId', async () => {
    const jobs = createJobs({
      jobRuns: createJobRuns(testPrisma()),
      clock: fixedClock(),
      release: '1.0',
    });
    const calls: string[] = [];
    // Registered out of plan order on purpose.
    jobs.registerJob('maintenance', () => Promise.resolve(), {
      forUser: (userId) => {
        calls.push(`maintenance:${userId}`);
        return Promise.resolve();
      },
    });
    jobs.registerJob('outbox.send', () => {
      calls.push('outbox.send:global');
      return Promise.resolve();
    });
    jobs.registerJob('fx.fetchParallel', () => Promise.resolve(), {
      forUser: (userId) => {
        calls.push(`fx.fetchParallel:${userId}`);
        return Promise.resolve();
      },
    });

    await jobs.catchUpUser('user-1');

    expect(calls).toEqual(['fx.fetchParallel:user-1', 'maintenance:user-1']);
  });

  it('RNF-13 catchUpUser no corre el alcance por usuario de un módulo que no está liberado', async () => {
    const jobs = createJobs({
      jobRuns: createJobRuns(testPrisma()),
      clock: fixedClock(),
      release: '1.0',
    });
    const calls: string[] = [];
    jobs.registerJob('recurring.generate', () => Promise.resolve(), {
      forUser: (userId) => {
        calls.push(`recurring.generate:${userId}`);
        return Promise.resolve();
      },
    });
    jobs.registerJob('maintenance', () => Promise.resolve(), {
      forUser: (userId) => {
        calls.push(`maintenance:${userId}`);
        return Promise.resolve();
      },
    });

    await jobs.catchUpUser('user-1');

    expect(calls).toEqual(['maintenance:user-1']);
  });

  it('RNF-13 un job que falla en catchUpUser no impide que corran los siguientes', async () => {
    const jobs = createJobs({
      jobRuns: createJobRuns(testPrisma()),
      clock: fixedClock(),
      release: '1.0',
    });
    const calls: string[] = [];
    jobs.registerJob('fx.fetchParallel', () => Promise.resolve(), {
      forUser: () => Promise.reject(new Error('boom')),
    });
    jobs.registerJob('maintenance', () => Promise.resolve(), {
      forUser: (userId) => {
        calls.push(userId);
        return Promise.resolve();
      },
    });

    try {
      await jobs.catchUpUser('user-1');
    } catch {
      // Whether catchUpUser reports the failed job is not fixed by the plan.
    }

    expect(calls).toEqual(['user-1']);
  });
});

// ---------- the catchUp middleware ----------

interface World {
  app: express.Express;
  calls: string[];
  setDay(tz: string, day: string): void;
}

/**
 * An app whose `req.auth` comes from the `x-user` and `x-tz` test headers (no header, no session),
 * with `catchUpUser` replaced by a probe.
 */
function buildWorld(catchUpUser: (userId: string) => Promise<void> = () => Promise.resolve()): World {
  const calls: string[] = [];
  const days = new Map<string, string>();
  const clock: Clock = {
    now: () => new Date('2026-10-19T12:00:00Z'),
    todayFor: (tz) => days.get(tz) ?? '2026-10-19',
  };
  const jobs = {
    catchUpUser: (userId: string) => {
      calls.push(userId);
      return catchUpUser(userId);
    },
  };
  const session: RequestHandler = (req, _res, next) => {
    const userId = req.get('x-user');
    if (userId !== undefined) {
      req.auth = {
        userId,
        sessionId: `session-${userId}`,
        timezone: req.get('x-tz') ?? 'America/La_Paz',
      };
    }
    next();
  };
  const app = express();
  app.use(session);
  app.use(catchUp({ jobs, clock }));
  app.get('/probe', (_req, res) => {
    res.status(200).json({ ok: true });
  });
  return { app, calls, setDay: (tz, day) => days.set(tz, day) };
}

const get = (w: World, userId?: string, tz?: string) => {
  const req = request(w.app).get('/probe');
  if (userId !== undefined) void req.set('x-user', userId);
  if (tz !== undefined) void req.set('x-tz', tz);
  return req;
};

const settle = () =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, 20);
  });

describe('catchUp middleware', () => {
  it('RNF-13 la primera petición autenticada del día dispara una puesta al día con el userId de la sesión', async () => {
    const w = buildWorld();

    const res = await get(w, 'user-1');
    await settle();

    expect(res.status).toBe(200);
    expect(w.calls).toEqual(['user-1']);
  });

  it('RNF-13 dos peticiones el mismo día disparan una sola puesta al día', async () => {
    const w = buildWorld();

    await get(w, 'user-1');
    await settle();
    await get(w, 'user-1');
    await settle();

    expect(w.calls).toEqual(['user-1']);
  });

  it('RNF-13 peticiones simultáneas del mismo usuario el mismo día disparan una sola puesta al día', async () => {
    const w = buildWorld();

    await Promise.all([get(w, 'user-1'), get(w, 'user-1'), get(w, 'user-1')]);
    await settle();

    expect(w.calls).toEqual(['user-1']);
  });

  it('RNF-13 un día nuevo vuelve a disparar la puesta al día', async () => {
    const w = buildWorld();

    await get(w, 'user-1');
    await settle();
    w.setDay('America/La_Paz', '2026-10-20');
    await get(w, 'user-1');
    await settle();
    await get(w, 'user-1');
    await settle();

    expect(w.calls).toEqual(['user-1', 'user-1']);
  });

  it('RNF-13 la puesta al día es por usuario: cada usuario dispara la suya', async () => {
    const w = buildWorld();

    await get(w, 'user-1');
    await get(w, 'user-2');
    await settle();

    expect([...w.calls].sort()).toEqual(['user-1', 'user-2']);
  });

  it('RNF-13 el día es el día local del usuario: cambia con su zona horaria', async () => {
    const w = buildWorld();
    w.setDay('America/La_Paz', '2026-10-19');
    w.setDay('Pacific/Auckland', '2026-10-20');

    await get(w, 'user-1', 'America/La_Paz');
    await settle();
    w.setDay('America/La_Paz', '2026-10-19');
    await get(w, 'user-1', 'America/La_Paz');
    await settle();
    expect(w.calls).toEqual(['user-1']);

    // Same user, now in a timezone whose local day is already the next one.
    await get(w, 'user-1', 'Pacific/Auckland');
    await settle();
    expect(w.calls).toEqual(['user-1', 'user-1']);
  });

  it('RNF-13 una petición sin sesión no dispara ninguna puesta al día', async () => {
    const w = buildWorld();

    const res = await get(w);
    await settle();

    expect(res.status).toBe(200);
    expect(w.calls).toEqual([]);
  });

  it('RNF-13 la respuesta no espera a la puesta al día', async () => {
    const never = new Promise<void>(() => undefined);
    const w = buildWorld(() => never);

    const res = await get(w, 'user-1');

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
    expect(w.calls).toEqual(['user-1']);
  });

  it('RNF-13 un error en la puesta al día no cambia la respuesta de la petición', async () => {
    const healthy = buildWorld();
    const failing = buildWorld(() => Promise.reject(new Error('boom')));

    const expected = await get(healthy, 'user-1');
    const res = await get(failing, 'user-1');
    await settle();

    expect(res.status).toBe(expected.status);
    expect(res.body).toEqual(expected.body);
    expect(failing.calls).toEqual(['user-1']);
  });

  it('RNF-13 un error síncrono en la puesta al día no cambia la respuesta de la petición', async () => {
    const w = buildWorld(() => {
      throw new Error('boom');
    });

    const res = await get(w, 'user-1');
    await settle();

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
  });
});
