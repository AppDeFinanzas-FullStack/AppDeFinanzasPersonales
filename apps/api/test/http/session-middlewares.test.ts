import express from 'express';
import request from 'supertest';
import { describe, expect, it } from 'vitest';

import type { ResolvedSession } from '../../src/application/ports/auth-gateway.js';
import { errorHandler } from '../../src/presentation/middlewares/error-handler.js';
import { requireSession } from '../../src/presentation/middlewares/require-session.js';
import { trackActivity } from '../../src/presentation/middlewares/track-activity.js';

/**
 * The plan (§4.1.2) fixes the behaviour of the middlewares but not their signatures. These tests
 * use:
 * - `requireSession({ auth, sessions, clock })`, where
 *   - `auth.getSession(token)` -> `{ sessionId, userId }` or `null` (the `AuthGateway` port);
 *   - `sessions.findActivity(sessionId)` -> `{ lastActivityAt: Date, timezone: string }` or `null`
 *     when the session no longer exists;
 *   - `clock.now()` -> `Date`;
 *   it reads the session cookie `__Secure-better-auth.session_token` (value `<token>.<signature>`,
 *   URL encoded) and leaves `req.auth = { userId, sessionId, timezone }`;
 * - `trackActivity({ sessions, clock })`, where `sessions.touch(sessionId, at)` stores the new
 *   `last_activity_at`; it runs after `requireSession`, reads `req.auth` and calls `next()`.
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
  lastActivityAt: Date;
  timezone: string;
}

const buildWorld = (start = new Date('2026-10-19T12:00:00Z')) => {
  let now = start;
  const tokens = new Map<string, ResolvedSession>();
  const stored = new Map<string, Stored>();
  const touches: { sessionId: string; at: Date }[] = [];

  const auth = {
    getSession: (token: string) => Promise.resolve(tokens.get(token) ?? null),
  };
  const sessions = {
    findActivity: (sessionId: string) => Promise.resolve(stored.get(sessionId) ?? null),
    touch: (sessionId: string, at: Date) => {
      touches.push({ sessionId, at });
      const row = stored.get(sessionId);
      if (row) row.lastActivityAt = at;
      return Promise.resolve();
    },
  };
  const clock = { now: () => now, todayFor: () => '2026-10-19' };

  const open = (opts: { lastActivityAt?: Date; timezone?: string } = {}) => {
    const n = tokens.size + 1;
    const session: ResolvedSession = { sessionId: `session-${n}`, userId: `user-${n}` };
    const token = `token${n}`;
    tokens.set(token, session);
    stored.set(session.sessionId, {
      lastActivityAt: opts.lastActivityAt ?? now,
      timezone: opts.timezone ?? 'America/La_Paz',
    });
    const cookie = `${COOKIE_NAME}=${encodeURIComponent(`${token}.firma`)}`;
    return { ...session, token, cookie };
  };

  const app = express();
  let seen: unknown;
  app.use(requireSession({ auth, sessions, clock }));
  app.use(trackActivity({ sessions, clock }));
  app.all('/probe', (req, res) => {
    seen = (req as unknown as { auth?: unknown }).auth;
    res.status(200).json({ ok: true });
  });
  app.use(errorHandler);

  return {
    app,
    open,
    touches,
    stored,
    seen: () => seen,
    revoke: (token: string) => tokens.delete(token),
    advance: (ms: number) => {
      now = new Date(now.getTime() + ms);
    },
    now: () => now,
  };
};

describe('requireSession', () => {
  it('RF-M1-07 una sesión vigente pasa y deja { userId, sessionId, timezone } en la petición', async () => {
    const w = buildWorld();
    const s = w.open({ timezone: 'America/Sao_Paulo' });

    const res = await request(w.app).get('/probe').set('Cookie', s.cookie);

    expect(res.status).toBe(200);
    expect(w.seen()).toEqual({
      userId: s.userId,
      sessionId: s.sessionId,
      timezone: 'America/Sao_Paulo',
    });
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

  it('RF-M2-08 una sesión con más de 30 días sin actividad da SESSION_EXPIRED 401', async () => {
    const w = buildWorld();
    const s = w.open({ lastActivityAt: new Date(w.now().getTime() - 30 * DAY - MINUTE) });

    const res = await request(w.app).get('/probe').set('Cookie', s.cookie);

    expect(res.status).toBe(401);
    expect(problem(res).code).toBe('SESSION_EXPIRED');
    expect(res.headers['content-type']).toMatch(/application\/problem\+json/);
  });

  it('RF-M2-08 una sesión con 29 días de inactividad sigue vigente', async () => {
    const w = buildWorld();
    const s = w.open({ lastActivityAt: new Date(w.now().getTime() - 29 * DAY) });

    const res = await request(w.app).get('/probe').set('Cookie', s.cookie);

    expect(res.status).toBe(200);
  });

  it('RF-M2-08 una sesión vencida no ejecuta el handler de la ruta', async () => {
    const w = buildWorld();
    const s = w.open({ lastActivityAt: new Date(w.now().getTime() - 31 * DAY) });

    await request(w.app).get('/probe').set('Cookie', s.cookie);

    expect(w.seen()).toBeUndefined();
  });

  it('RF-M2-08 una petición sin cookie da SESSION_EXPIRED 401', async () => {
    const w = buildWorld();

    const res = await request(w.app).get('/probe');

    expect(res.status).toBe(401);
    expect(problem(res).code).toBe('SESSION_EXPIRED');
  });

  it('RF-M2-08 una cookie con un token desconocido da SESSION_EXPIRED 401', async () => {
    const w = buildWorld();

    const res = await request(w.app)
      .get('/probe')
      .set('Cookie', `${COOKIE_NAME}=${encodeURIComponent('nadie.firma')}`);

    expect(res.status).toBe(401);
    expect(problem(res).code).toBe('SESSION_EXPIRED');
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

  it('EC-M1-06 una sesión de una cuenta eliminada (la sesión ya no existe) da SESSION_EXPIRED en su siguiente acción', async () => {
    const w = buildWorld();
    const s = w.open();
    w.stored.delete(s.sessionId);

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
    expect(w.stored.get(s.sessionId)?.lastActivityAt).toEqual(w.now());
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
    expect(w.stored.get(s.sessionId)?.lastActivityAt).toEqual(old);
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
});
