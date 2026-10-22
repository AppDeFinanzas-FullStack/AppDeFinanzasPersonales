import { NotificationDto } from '@finanzas/contracts';
import type { Express } from 'express';
import request from 'supertest';
import { uuidv7 } from 'uuidv7';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { buildContainer, createApp, type Container } from '../../src/composition/container.js';
import { parseEnv } from '../../src/infrastructure/config/env.js';
import { disconnectTestPrisma, testPrisma } from '../integration/setup/db.js';

/**
 * The inbox endpoints (plan §4.15.2) over the test database with fake integrations:
 * `GET /api/notifications` (by cursor, newest first), `GET /api/notifications/unread-count`
 * (asked with `X-Background`), `POST /api/notifications/:id/read`, `POST /api/notifications/read-all`
 * and `DELETE /api/notifications/:id`, all behind the M15 `releaseGate` (V1.1).
 *
 * The plan fixes the routes and the item shape (`NotificationDto`); it does not fix the success
 * status nor the envelopes, so a success is any 2xx answer, the list is either an array of
 * `NotificationDto` or an object that carries that array (and its cursor in a field whose name
 * contains "cursor", `null` or absent on the last page), and the unread count is either a number
 * or an object with a single numeric field. `releaseGate` reads `RELEASE` from the process
 * environment on each request.
 */
const WEB_ORIGIN = 'http://localhost:5173';
const COOKIE_NAME = '__Secure-better-auth.session_token';

const envSource = (): Record<string, string> => ({
  NODE_ENV: 'test',
  PORT: '3000',
  DATABASE_URL: process.env['TEST_DATABASE_URL'] ?? '',
  AUTH_SECRET: 'auth-secret-value-0123456789abcdef0123456789',
  HMAC_SECRET: 'hmac-secret-value-0123456789abcdef0123456789',
  JOBS_SECRET: 'jobs-secret-value-0123456789abcdef0123456789',
  RESEND_API_KEY: 're_resend-key-value-0123456789',
  RELEASE: '1.1',
  WEB_ORIGIN,
  INTEGRATIONS: 'fake',
});

interface Problem {
  code?: string;
  status?: number;
}
const problem = (res: { body: unknown }) => res.body as Problem;

interface Account {
  cookie: string;
  userId: string;
}

interface NotificationRow {
  id: string;
  readAt: Date | null;
  decisionKind: string | null;
  decisionRef: string | null;
  decisionStatus: string | null;
}

const db = testPrisma();
let container: Container;
let app: Express;
const usedEmails: string[] = [];
const originalRelease = process.env['RELEASE'];

const sleep = (ms: number) =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });

const sessionCookieOf = (res: { headers: Record<string, unknown> }): string => {
  const raw = res.headers['set-cookie'];
  const list = typeof raw === 'string' ? [raw] : Array.isArray(raw) ? (raw as unknown[]) : [];
  const header = list.find(
    (c): c is string => typeof c === 'string' && c.startsWith(`${COOKIE_NAME}=`),
  );
  if (header === undefined) throw new Error('the response sets no session cookie');
  return header.split(';')[0] ?? '';
};

async function signedIn(): Promise<Account> {
  const support = container.testSupport;
  if (support === null) throw new Error('test support is off');
  const { email, password } = await support.createUser();
  usedEmails.push(email);
  const res = await request(app)
    .post('/api/auth/sign-in')
    .set('Origin', WEB_ORIGIN)
    .send({ email, password });
  expect(res.status).toBe(200);
  const rows = await db.$queryRaw<{ id: string }[]>`
    SELECT id::text AS id FROM auth_user WHERE email = ${email}`;
  const userId = rows[0]?.id;
  if (userId === undefined) throw new Error('the signed-in user is not in auth_user');
  return { cookie: sessionCookieOf(res), userId };
}

interface SeedOptions {
  createdAt?: Date;
  read?: boolean;
  decision?: { kind: 'budget_period' | 'occurrence'; ref: string };
}

/** Inserts a notification of the user straight into the table and returns its id. */
async function seedNotification(userId: string, options: SeedOptions = {}): Promise<string> {
  const id = uuidv7();
  const createdAt = options.createdAt ?? new Date();
  const readAt = options.read === true ? new Date() : null;
  const decision = options.decision;
  await db.$executeRawUnsafe(
    `INSERT INTO notification
       (id, user_id, type, event_key, params, target_route,
        decision_kind, decision_ref, decision_status, read_at, created_at)
     VALUES ($1::uuid, $2::uuid, 'budget_alert'::notification_type, $3, $4::jsonb, '/presupuestos',
             $5, $6::uuid, $7::decision_status, $8, $9)`,
    id,
    userId,
    `test:${id}`,
    JSON.stringify({ budgetName: 'Comida', percent: 80 }),
    decision?.kind ?? null,
    decision?.ref ?? null,
    decision === undefined ? null : 'waiting',
    readAt,
    createdAt,
  );
  return id;
}

async function rowsOf(userId: string): Promise<NotificationRow[]> {
  return db.$queryRaw<NotificationRow[]>`
    SELECT id::text AS id, read_at AS "readAt", decision_kind AS "decisionKind",
           decision_ref::text AS "decisionRef", decision_status::text AS "decisionStatus"
      FROM notification WHERE user_id = ${userId}::uuid ORDER BY created_at DESC, id DESC`;
}

async function rowOf(id: string): Promise<NotificationRow | undefined> {
  const rows = await db.$queryRaw<NotificationRow[]>`
    SELECT id::text AS id, read_at AS "readAt", decision_kind AS "decisionKind",
           decision_ref::text AS "decisionRef", decision_status::text AS "decisionStatus"
      FROM notification WHERE id = ${id}::uuid`;
  return rows[0];
}

const getList = (cookie: string | null, cursor?: string) => {
  const req = request(app).get('/api/notifications');
  if (cursor !== undefined) req.query({ cursor });
  if (cookie !== null) req.set('Cookie', cookie);
  return req;
};

const getUnreadCount = (cookie: string | null) => {
  const req = request(app).get('/api/notifications/unread-count').set('X-Background', '1');
  if (cookie !== null) req.set('Cookie', cookie);
  return req;
};

const postRead = (id: string, cookie: string | null) => {
  const req = request(app).post(`/api/notifications/${id}/read`).set('Origin', WEB_ORIGIN);
  if (cookie !== null) req.set('Cookie', cookie);
  return req.send({});
};

const postReadAll = (cookie: string | null) => {
  const req = request(app).post('/api/notifications/read-all').set('Origin', WEB_ORIGIN);
  if (cookie !== null) req.set('Cookie', cookie);
  return req.send({});
};

const deleteOne = (id: string, cookie: string | null) => {
  const req = request(app).delete(`/api/notifications/${id}`).set('Origin', WEB_ORIGIN);
  if (cookie !== null) req.set('Cookie', cookie);
  return req;
};

const expectSuccess = (res: { status: number }) => {
  expect(res.status).toBeGreaterThanOrEqual(200);
  expect(res.status).toBeLessThan(300);
};

/** The list items, whether the body is the array or wraps it. */
const listOf = (body: unknown): unknown[] => {
  if (Array.isArray(body)) return body as unknown[];
  if (typeof body === 'object' && body !== null) {
    const arrays = Object.values(body as Record<string, unknown>).filter(Array.isArray);
    if (arrays.length === 1) return arrays[0] as unknown[];
  }
  throw new Error('the body of GET /api/notifications carries no list');
};

/** The cursor of the next page, or `null` when the body carries none. */
const cursorOf = (body: unknown): string | null => {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return null;
  const entry = Object.entries(body as Record<string, unknown>).find(([key]) =>
    key.toLowerCase().includes('cursor'),
  );
  const value = entry?.[1];
  return typeof value === 'string' ? value : null;
};

/** The listed notifications, each checked against `NotificationDto`. */
async function listed(cookie: string): Promise<NotificationDto[]> {
  const res = await getList(cookie);
  expect(res.status).toBe(200);
  return listOf(res.body).map((item) => NotificationDto.parse(item));
}

/** The unread count, whether the body is the number or an object with a single number. */
const countOf = (body: unknown): number => {
  if (typeof body === 'number') return body;
  if (typeof body === 'object' && body !== null) {
    const numbers = Object.values(body as Record<string, unknown>).filter(
      (v): v is number => typeof v === 'number',
    );
    if (numbers.length === 1 && numbers[0] !== undefined) return numbers[0];
  }
  throw new Error('the body of GET /api/notifications/unread-count carries no count');
};

async function unreadCount(cookie: string): Promise<number> {
  const res = await getUnreadCount(cookie);
  expect(res.status).toBe(200);
  return countOf(res.body);
}

const minutesAgo = (minutes: number) => new Date(Date.now() - minutes * 60_000);

beforeAll(async () => {
  process.env['RELEASE'] = '1.1';
  container = await Promise.resolve(buildContainer(parseEnv(envSource())));
  app = await Promise.resolve(createApp(container));
}, 30_000);

afterEach(() => {
  process.env['RELEASE'] = '1.1';
});

afterAll(async () => {
  if (originalRelease === undefined) delete process.env['RELEASE'];
  else process.env['RELEASE'] = originalRelease;
  await sleep(300);
  await db.$executeRaw`DELETE FROM auth_user WHERE email = ANY(${usedEmails}::text[])`;
  await db.$executeRaw`DELETE FROM email_outbox WHERE to_address = ANY(${usedEmails}::text[])`;
  await disconnectTestPrisma();
  await container.prisma.$disconnect();
}, 30_000);

describe('GET /api/notifications', () => {
  it('TASK-177 sin sesión responde 401', async () => {
    expect((await getList(null)).status).toBe(401);
  });

  it('TASK-177 lista los avisos del usuario del más nuevo al más viejo', async () => {
    const { cookie, userId } = await signedIn();
    const oldest = await seedNotification(userId, { createdAt: minutesAgo(30) });
    const newest = await seedNotification(userId, { createdAt: minutesAgo(1), read: true });
    const middle = await seedNotification(userId, { createdAt: minutesAgo(10) });

    const items = await listed(cookie);

    expect(items.map((n) => n.id)).toEqual([newest, middle, oldest]);
    expect(items.map((n) => n.read)).toEqual([true, false, false]);
  });

  it('TASK-177 pagina por cursor: 20 por defecto y la página siguiente trae el resto', async () => {
    const { cookie, userId } = await signedIn();
    const ids: string[] = [];
    for (let i = 0; i < 23; i += 1) {
      ids.push(await seedNotification(userId, { createdAt: minutesAgo(100 - i) }));
    }
    const newestFirst = [...ids].reverse();

    const first = await getList(cookie);
    expect(first.status).toBe(200);
    const firstItems = listOf(first.body).map((item) => NotificationDto.parse(item));
    expect(firstItems.map((n) => n.id)).toEqual(newestFirst.slice(0, 20));
    const cursor = cursorOf(first.body);
    expect(cursor).not.toBeNull();

    const second = await getList(cookie, cursor ?? '');
    expect(second.status).toBe(200);
    const secondItems = listOf(second.body).map((item) => NotificationDto.parse(item));
    expect(secondItems.map((n) => n.id)).toEqual(newestFirst.slice(20));
    expect(cursorOf(second.body)).toBeNull();
  });

  it('RNF-14 la lista no incluye los avisos de otro usuario', async () => {
    const a = await signedIn();
    const b = await signedIn();
    await seedNotification(a.userId);
    const own = await seedNotification(b.userId);

    expect((await listed(b.cookie)).map((n) => n.id)).toEqual([own]);
  });
});

describe('GET /api/notifications/unread-count', () => {
  it('TASK-177 sin sesión responde 401', async () => {
    expect((await getUnreadCount(null)).status).toBe(401);
  });

  it('RF-M15-06 el contador cuenta solo los avisos no leídos', async () => {
    const { cookie, userId } = await signedIn();
    await seedNotification(userId);
    await seedNotification(userId, { read: true });
    await seedNotification(userId, {
      decision: { kind: 'occurrence', ref: uuidv7() },
    });
    await seedNotification(userId, { read: true });

    expect(await unreadCount(cookie)).toBe(2);
  });

  it('RF-M15-06 un usuario sin avisos tiene el contador en 0', async () => {
    const { cookie } = await signedIn();
    expect(await unreadCount(cookie)).toBe(0);
  });

  it('RF-M15-06 marcar un aviso como leído baja el contador en uno', async () => {
    const { cookie, userId } = await signedIn();
    const first = await seedNotification(userId);
    await seedNotification(userId);

    expectSuccess(await postRead(first, cookie));

    expect(await unreadCount(cookie)).toBe(1);
  });

  it('RNF-14 el contador no cuenta los avisos no leídos de otro usuario', async () => {
    const a = await signedIn();
    const b = await signedIn();
    await seedNotification(a.userId);
    await seedNotification(a.userId);
    await seedNotification(b.userId);

    expect(await unreadCount(b.cookie)).toBe(1);
  });
});

describe('POST /api/notifications/:id/read', () => {
  it('TASK-177 sin sesión responde 401', async () => {
    expect((await postRead(uuidv7(), null)).status).toBe(401);
  });

  it('TASK-177 marca el aviso como leído y la lista lo muestra leído', async () => {
    const { cookie, userId } = await signedIn();
    const id = await seedNotification(userId);
    const other = await seedNotification(userId, { createdAt: minutesAgo(5) });

    expectSuccess(await postRead(id, cookie));

    expect((await rowOf(id))?.readAt).not.toBeNull();
    expect((await rowOf(other))?.readAt).toBeNull();
    const item = (await listed(cookie)).find((n) => n.id === id);
    expect(item?.read).toBe(true);
  });

  it('RF-M15-12 marcar como leído un aviso que espera una decisión deja la decisión pendiente', async () => {
    const { cookie, userId } = await signedIn();
    const ref = uuidv7();
    const id = await seedNotification(userId, { decision: { kind: 'budget_period', ref } });

    expectSuccess(await postRead(id, cookie));

    expect(await rowOf(id)).toEqual({
      id,
      readAt: expect.any(Date) as Date,
      decisionKind: 'budget_period',
      decisionRef: ref,
      decisionStatus: 'waiting',
    });
    const item = (await listed(cookie)).find((n) => n.id === id);
    expect(item?.read).toBe(true);
    expect(item?.decision).toEqual({ kind: 'budget_period', ref, status: 'waiting' });
  });

  it('RNF-14 el usuario B recibe 404 al marcar como leído un aviso de A, que sigue sin leer', async () => {
    const a = await signedIn();
    const b = await signedIn();
    const id = await seedNotification(a.userId);

    const res = await postRead(id, b.cookie);

    expect(res.status).toBe(404);
    expect(problem(res).status).toBe(404);
    expect((await rowOf(id))?.readAt).toBeNull();
  });

  it('RNF-14 un id inexistente responde 404', async () => {
    const { cookie } = await signedIn();
    expect((await postRead(uuidv7(), cookie)).status).toBe(404);
  });
});

describe('POST /api/notifications/read-all', () => {
  it('TASK-177 sin sesión responde 401', async () => {
    expect((await postReadAll(null)).status).toBe(401);
  });

  it('RF-M15-12 marcar todo como leído incluye los avisos que esperan una decisión y la decisión sigue pendiente', async () => {
    const { cookie, userId } = await signedIn();
    const ref = uuidv7();
    const plain = await seedNotification(userId, { createdAt: minutesAgo(3) });
    const waiting = await seedNotification(userId, {
      createdAt: minutesAgo(2),
      decision: { kind: 'occurrence', ref },
    });

    expectSuccess(await postReadAll(cookie));

    const rows = await rowsOf(userId);
    expect(rows.map((r) => r.id)).toEqual([waiting, plain]);
    expect(rows.every((r) => r.readAt !== null)).toBe(true);
    expect(rows[0]).toMatchObject({
      decisionKind: 'occurrence',
      decisionRef: ref,
      decisionStatus: 'waiting',
    });
    expect(await unreadCount(cookie)).toBe(0);
    const item = (await listed(cookie)).find((n) => n.id === waiting);
    expect(item?.decision).toEqual({ kind: 'occurrence', ref, status: 'waiting' });
  });

  it('RNF-14 marcar todo como leído no toca los avisos de otro usuario', async () => {
    const a = await signedIn();
    const b = await signedIn();
    const ofA = await seedNotification(a.userId);
    await seedNotification(b.userId);

    expectSuccess(await postReadAll(b.cookie));

    expect((await rowOf(ofA))?.readAt).toBeNull();
    expect(await unreadCount(a.cookie)).toBe(1);
  });
});

describe('DELETE /api/notifications/:id', () => {
  it('TASK-177 sin sesión responde 401', async () => {
    expect((await deleteOne(uuidv7(), null)).status).toBe(401);
  });

  it('TASK-177 elimina el aviso y deja de aparecer en la lista', async () => {
    const { cookie, userId } = await signedIn();
    const gone = await seedNotification(userId);
    const kept = await seedNotification(userId, { createdAt: minutesAgo(5) });

    expectSuccess(await deleteOne(gone, cookie));

    expect(await rowOf(gone)).toBeUndefined();
    expect((await listed(cookie)).map((n) => n.id)).toEqual([kept]);
  });

  it('RF-M15-12 eliminar un aviso que espera una decisión lo borra sin resolver la decisión', async () => {
    const { cookie, userId } = await signedIn();
    const ref = uuidv7();
    const id = await seedNotification(userId, { decision: { kind: 'occurrence', ref } });

    expectSuccess(await deleteOne(id, cookie));

    expect(await rowOf(id)).toBeUndefined();
    expect(await unreadCount(cookie)).toBe(0);
  });

  it('RNF-14 el usuario B recibe 404 al eliminar un aviso de A, que sigue existiendo', async () => {
    const a = await signedIn();
    const b = await signedIn();
    const id = await seedNotification(a.userId);

    const res = await deleteOne(id, b.cookie);

    expect(res.status).toBe(404);
    expect(problem(res).status).toBe(404);
    expect((await rowOf(id))?.id).toBe(id);
  });
});

describe('releaseGate de la bandeja (M15, V1.1)', () => {
  it('TASK-177 con RELEASE=1.0 todas las rutas de la bandeja responden 404 RELEASE_NOT_AVAILABLE', async () => {
    const { cookie, userId } = await signedIn();
    const id = await seedNotification(userId);
    process.env['RELEASE'] = '1.0';

    const responses = [
      await getList(cookie),
      await getUnreadCount(cookie),
      await postRead(id, cookie),
      await postReadAll(cookie),
      await deleteOne(id, cookie),
    ];

    for (const res of responses) {
      expect(res.status).toBe(404);
      expect(problem(res).code).toBe('RELEASE_NOT_AVAILABLE');
    }
    expect(await rowOf(id)).toMatchObject({ id, readAt: null });
  });
});
