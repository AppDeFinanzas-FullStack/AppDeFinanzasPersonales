import express from 'express';
import request from 'supertest';
import { describe, expect, it } from 'vitest';

import { errorHandler } from '../../src/presentation/middlewares/error-handler.js';
import { requireSession } from '../../src/presentation/middlewares/require-session.js';
import { trackActivity } from '../../src/presentation/middlewares/track-activity.js';

/**
 * The plan (§4.0, "Sesión en una consulta") fixes the behaviour of the middlewares but not their
 * signatures. These tests use:
 * - `requireSession({ sessions, clock })`, where
 *   - `sessions.findByToken(token)` -> `{ sessionId, userId, expiresAt, lastActivityAt, timezone }`
 *     or `null` when no session has that token (one statement joining the session and the user);
 *   - `clock.now()` -> `Date`;
 *   it reads the session cookie `__Secure-better-auth.session_token` (value `<token>.<signature>`,
 *   URL encoded), validates `expiresAt` and the 30 days of inactivity, and leaves
 *   `req.auth = { userId, sessionId, timezone, lastActivityAt }`;
 * - `trackActivity({ sessions, clock })`, where `sessions.touch(sessionId, at)` stores the new
 *   `last_activity_at`; it runs after `requireSession`, reads `req.auth` (it does not query the
 *   session again) and calls `next()`.
 * `auth.getSession` and `sessions.findActivity` are passed as spies: they must never be called.
 */
const COOKIE_NAME = '__Secure-better-auth.session_token';
const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;

interface Problem {
  code?: string;
  status?: number;
}
const problem = (res: { body: unknown }) => res.body as Problem;

interface Stored {
  sessionId: string;
  userId: string;
  expiresAt: Date;
  lastActivityAt: Date;
  timezone: string;
}

const buildWorld = (start = new Date('2026-10-19T12:00:00Z')) => {
  let now = start;
  const byToken = new Map<string, Stored>();
  const touches: { sessionId: string; at: Date }[] = [];
  const calls = { findByToken: [] as string[], findActivity: 0, getSession: 0 };

  const auth = {
    getSession: () => {
      calls.getSession += 1;
      return Promise.resolve(null);
    },
  };
  const sessions = {
    findByToken: (token: string) => {
      calls.findByToken.push(token);
      const row = byToken.get(token);
      return Promise.resolve(row === undefined ? null : { ...row });
    },
    findActivity: () => {
      calls.findActivity += 1;
      return Promise.resolve(null);
    },
    touch: (sessionId: string, at: Date) => {
      touches.push({ sessionId, at });
      for (const row of byToken.values()) {
        if (row.sessionId === sessionId) row.lastActivityAt = at;
      }
      return Promise.resolve();
    },
  };
  const clock = { now: () => now, todayFor: () => '2026-10-19' };
  const deps = { auth, sessions, clock };

  const open = (
    opts: { lastActivityAt?: Date; expiresAt?: Date; timezone?: string } = {},
  ) => {
    const n = byToken.size + 1;
    const token = `token${n}`;
    const row: Stored = {
      sessionId: `session-${n}`,
      userId: `user-${n}`,
      expiresAt: opts.expiresAt ?? new Date(now.getTime() + 30 * DAY),
      lastActivityAt: opts.lastActivityAt ?? now,
      timezone: opts.timezone ?? 'America/La_Paz',
    };
    byToken.set(token, row);
    const cookie = `${COOKIE_NAME}=${encodeURIComponent(`${token}.firma`)}`;
    return { ...row, token, cookie };
  };

  const app = express();
  let seen: unknown;
  app.use(requireSession(deps));
  app.use(trackActivity(deps));
  app.all('/probe', (req, res) => {
    seen = (req as unknown as { auth?: unknown }).auth;
    res.status(200).json({ ok: true });
  });
  app.use(errorHandler);

  return {
    app,
    deps,
    open,
    touches,
    calls,
    stored: (token: string) => byToken.get(token),
    seen: () => seen,
    revoke: (token: string) => byToken.delete(token),
    advance: (ms: number) => {
      now = new Date(now.getTime() + ms);
    },
    now: () => now,
  };
};

describe('requireSession', () => {
  it('RF-M1-07 una sesión vigente pasa y deja { userId, sessionId, timezone, lastActivityAt } en la petición', async () => {
    const w = buildWorld();
    const s = w.open({ timezone: 'America/Sao_Paulo' });

    const res = await request(w.app).get('/probe').set('Cookie', s.cookie);

    expect(res.status).toBe(200);
    expect(w.seen()).toEqual({
      userId: s.userId,
      sessionId: s.sessionId,
      timezone: 'America/Sao_Paulo',
      lastActivityAt: s.lastActivityAt,
    });
  });

  it('RNF-29 una petición autenticada consulta la sesión una sola vez, con el token de la cookie', async () => {
    const w = buildWorld();
    const s = w.open({ lastActivityAt: new Date(w.now().getTime() - 10 * MINUTE) });

    const res = await request(w.app).get('/probe').set('Cookie', s.cookie);

    expect(res.status).toBe(200);
    expect(w.calls.findByToken).toEqual([s.token]);
    expect(w.calls.findActivity).toBe(0);
    expect(w.calls.getSession).toBe(0);
  });

  it('RNF-29 trackActivity no vuelve a consultar la sesión aunque deba renovarla', async () => {
    const w = buildWorld();
    const s = w.open({ lastActivityAt: new Date(w.now().getTime() - 10 * MINUTE) });

    await request(w.app).get('/probe').set('Cookie', s.cookie);
    await request(w.app).get('/probe').set('Cookie', s.cookie);

    expect(w.calls.findByToken).toHaveLength(2);
    expect(w.calls.findActivity).toBe(0);
    expect(w.touches).toHaveLength(1);
  });

  it('RF-M1-07 dos sesiones simultáneas de dispositivos distintos pasan', async () => {
    const w = buildWorld();
    const a = w.open();
    const b = w.open();

    const resA = await request(w.app).get('/probe').set('Cookie', a.cookie);
    const resB = await request(w.app).get('/probe').set('Cookie', b.cookie);

    expect(resA.status).toBe(200);
    expect(resB.status).toBe(200);
  });

  it('RF-M1-07 una sesión con más de 30 días sin actividad da SESSION_EXPIRED 401', async () => {
    const w = buildWorld();
    const s = w.open({
      lastActivityAt: new Date(w.now().getTime() - 31 * DAY),
      expiresAt: new Date(w.now().getTime() + 5 * DAY),
    });

    const res = await request(w.app).get('/probe').set('Cookie', s.cookie);

    expect(res.status).toBe(401);
    expect(problem(res).code).toBe('SESSION_EXPIRED');
    expect(res.headers['content-type']).toMatch(/application\/problem\+json/);
  });

  it('RF-M1-07 una sesión con 29 días de inactividad sigue vigente', async () => {
    const w = buildWorld();
    const s = w.open({ lastActivityAt: new Date(w.now().getTime() - 29 * DAY) });

    const res = await request(w.app).get('/probe').set('Cookie', s.cookie);

    expect(res.status).toBe(200);
  });

  it('RF-M2-08 una sesión vencida por inactividad no ejecuta el handler de la ruta', async () => {
    const w = buildWorld();
    const s = w.open({ lastActivityAt: new Date(w.now().getTime() - 31 * DAY) });

    await request(w.app).get('/probe').set('Cookie', s.cookie);

    expect(w.seen()).toBeUndefined();
  });

  it('RF-M2-08 una sesión con expiresAt en el pasado da SESSION_EXPIRED 401', async () => {
    const w = buildWorld();
    const s = w.open({ expiresAt: new Date(w.now().getTime() - MINUTE) });

    const res = await request(w.app).get('/probe').set('Cookie', s.cookie);

    expect(res.status).toBe(401);
    expect(problem(res).code).toBe('SESSION_EXPIRED');
    expect(w.seen()).toBeUndefined();
    expect(w.touches).toHaveLength(0);
  });

  it('RF-M2-08 una sesión que vence exactamente ahora da SESSION_EXPIRED 401', async () => {
    const w = buildWorld();
    const s = w.open({ expiresAt: new Date(w.now().getTime()) });

    const res = await request(w.app).get('/probe').set('Cookie', s.cookie);

    expect(res.status).toBe(401);
    expect(problem(res).code).toBe('SESSION_EXPIRED');
  });

  it('RF-M2-08 una petición sin cookie da SESSION_EXPIRED 401 sin consultar la sesión', async () => {
    const w = buildWorld();

    const res = await request(w.app).get('/probe');

    expect(res.status).toBe(401);
    expect(problem(res).code).toBe('SESSION_EXPIRED');
    expect(w.calls.findByToken).toHaveLength(0);
  });

  it('RF-M2-08 una cookie con un token desconocido da SESSION_EXPIRED 401', async () => {
    const w = buildWorld();

    const res = await request(w.app)
      .get('/probe')
      .set('Cookie', `${COOKIE_NAME}=${encodeURIComponent('nadie.firma')}`);

    expect(res.status).toBe(401);
    expect(problem(res).code).toBe('SESSION_EXPIRED');
    expect(w.calls.findByToken).toEqual(['nadie']);
  });

  it('EC-M1-05 una sesión revocada (cambio de contraseña en otro dispositivo) da SESSION_EXPIRED en su siguiente acción', async () => {
    const w = buildWorld();
    const s = w.open();
    expect((await request(w.app).get('/probe').set('Cookie', s.cookie)).status).toBe(200);

    w.revoke(s.token);
    const res = await request(w.app).get('/probe').set('Cookie', s.cookie);

    expect(res.status).toBe(401);
    expect(problem(res).code).toBe('SESSION_EXPIRED');
  });

  it('EC-M1-05 no hay caché: cada petición vuelve a consultar la sesión', async () => {
    const w = buildWorld();
    const s = w.open();

    for (let i = 0; i < 3; i += 1) {
      await request(w.app).get('/probe').set('Cookie', s.cookie);
    }

    expect(w.calls.findByToken).toEqual([s.token, s.token, s.token]);
  });

  it('EC-M1-06 una sesión de una cuenta eliminada (la sesión ya no existe) da SESSION_EXPIRED en su siguiente acción', async () => {
    const w = buildWorld();
    const s = w.open();
    expect((await request(w.app).get('/probe').set('Cookie', s.cookie)).status).toBe(200);
    w.revoke(s.token);

    const res = await request(w.app).get('/probe').set('Cookie', s.cookie);

    expect(res.status).toBe(401);
    expect(problem(res).code).toBe('SESSION_EXPIRED');
  });
});

describe('trackActivity', () => {
  it('RF-M1-07 una petición normal con la actividad vieja renueva last_activity_at', async () => {
    const w = buildWorld();
    const s = w.open({ lastActivityAt: new Date(w.now().getTime() - 10 * MINUTE) });

    const res = await request(w.app).get('/probe').set('Cookie', s.cookie);

    expect(res.status).toBe(200);
    expect(w.touches).toEqual([{ sessionId: s.sessionId, at: w.now() }]);
    expect(w.stored(s.token)?.lastActivityAt).toEqual(w.now());
  });

  it('RF-M1-07 una petición con X-Background no renueva la sesión', async () => {
    const w = buildWorld();
    const old = new Date(w.now().getTime() - 10 * MINUTE);
    const s = w.open({ lastActivityAt: old });

    const res = await request(w.app)
      .get('/probe')
      .set('Cookie', s.cookie)
      .set('X-Background', '1');

    expect(res.status).toBe(200);
    expect(w.touches).toHaveLength(0);
    expect(w.stored(s.token)?.lastActivityAt).toEqual(old);
  });

  it('RF-M1-07 una petición X-Background tampoco renueva con POST', async () => {
    const w = buildWorld();
    const s = w.open({ lastActivityAt: new Date(w.now().getTime() - 20 * MINUTE) });

    await request(w.app).post('/probe').set('Cookie', s.cookie).set('X-Background', '1').send({});

    expect(w.touches).toHaveLength(0);
  });

  it('RF-M1-07 dentro de los 5 minutos de la última actividad no se vuelve a escribir', async () => {
    const w = buildWorld();
    const s = w.open({ lastActivityAt: new Date(w.now().getTime() - 4 * MINUTE) });

    await request(w.app).get('/probe').set('Cookie', s.cookie);

    expect(w.touches).toHaveLength(0);
  });

  it('RF-M1-07 la renovación ocurre como máximo cada 5 minutos', async () => {
    const w = buildWorld();
    const s = w.open({ lastActivityAt: new Date(w.now().getTime() - 6 * MINUTE) });

    await request(w.app).get('/probe').set('Cookie', s.cookie);
    expect(w.touches).toHaveLength(1);

    w.advance(2 * MINUTE);
    await request(w.app).get('/probe').set('Cookie', s.cookie);
    expect(w.touches).toHaveLength(1);

    w.advance(4 * MINUTE);
    await request(w.app).get('/probe').set('Cookie', s.cookie);
    expect(w.touches).toHaveLength(2);
  });

  it('RF-M1-07 una sesión vencida no se renueva al ser rechazada', async () => {
    const w = buildWorld();
    const s = w.open({ lastActivityAt: new Date(w.now().getTime() - 31 * DAY) });

    await request(w.app).get('/probe').set('Cookie', s.cookie);

    expect(w.touches).toHaveLength(0);
  });

  it('RNF-29 trackActivity decide con el lastActivityAt de req.auth y no consulta nada', async () => {
    const w = buildWorld();
    const start = w.now();
    const stale = new Date(start.getTime() - 10 * MINUTE);
    const fresh = new Date(start.getTime() - MINUTE);
    const withAuth = (lastActivityAt: Date): express.Express => {
      const app = express();
      app.use((req, _res, next) => {
        (req as unknown as { auth: unknown }).auth = {
          userId: 'user-x',
          sessionId: 'session-x',
          timezone: 'America/La_Paz',
          lastActivityAt,
        };
        next();
      });
      app.use(trackActivity(w.deps));
      app.get('/probe', (_req, res) => {
        res.status(200).json({ ok: true });
      });
      return app;
    };

    await request(withAuth(fresh)).get('/probe');
    expect(w.touches).toHaveLength(0);

    await request(withAuth(stale)).get('/probe');
    expect(w.touches).toEqual([{ sessionId: 'session-x', at: start }]);
    expect(w.calls.findByToken).toHaveLength(0);
    expect(w.calls.findActivity).toBe(0);
  });
});
