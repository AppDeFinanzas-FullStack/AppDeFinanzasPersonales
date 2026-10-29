import { createHash, createHmac, randomUUID } from 'node:crypto';

import { ConfirmationStatusDto, ConfirmDto, MeDto } from '@finanzas/contracts';
import type { Express } from 'express';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { buildContainer, createApp, type Container } from '../../src/composition/container.js';
import { parseEnv } from '../../src/infrastructure/config/env.js';
import { disconnectTestPrisma, testPrisma } from '../integration/setup/db.js';

/**
 * The plan fixes the routes `/api/auth/*` of §4.1.2, their inputs (`contracts`, §4.1.1) and their
 * answers. These tests drive the app the composition root builds (`buildContainer(env)` and
 * `createApp(container)`, TASK-036) over the test database (`TEST_DATABASE_URL`) with fake
 * integrations, so nothing leaves the process. Accounts are made through `sign-up`, and their
 * links are read from the `payload.link` of the emails left in `email_outbox`.
 * The session cookie is `__Secure-better-auth.session_token` (TASK-050, TASK-058). Since TASK-265
 * the link of `confirm` only confirms: the session comes from `POST /api/auth/confirmation/status`
 * with the `__Secure-signup-ticket` cookie the sign-up sets (RF-M1-18).
 */
const WEB_ORIGIN = 'http://localhost:5173';
const COOKIE_NAME = '__Secure-better-auth.session_token';
const TICKET_COOKIE = '__Secure-signup-ticket';
const HMAC_SECRET = 'hmac-secret-value-0123456789abcdef0123456789';
const PASSWORD = 'Clave-segura-123';
const NEW_PASSWORD = 'Clave-nueva-456';
const WRONG_PASSWORD = 'Clave-incorrecta-999';
const UNKNOWN_TOKEN = 'A'.repeat(43);

const envSource = (): Record<string, string> => ({
  NODE_ENV: 'test',
  PORT: '3000',
  DATABASE_URL: process.env['TEST_DATABASE_URL'] ?? '',
  AUTH_SECRET: 'auth-secret-value-0123456789abcdef0123456789',
  HMAC_SECRET,
  JOBS_SECRET: 'jobs-secret-value-0123456789abcdef0123456789',
  RESEND_API_KEY: 're_resend-key-value-0123456789',
  RELEASE: '1.0',
  WEB_ORIGIN,
  INTEGRATIONS: 'fake',
});

interface Problem {
  code?: string;
  status?: number;
  data?: Record<string, unknown>;
  traceId?: string;
}
const problem = (res: { body: unknown }) => res.body as Problem;

interface SignInBody {
  me?: unknown;
  next?: unknown;
}

let container: Container;
let app: Express;

beforeAll(async () => {
  container = await Promise.resolve(buildContainer(parseEnv(envSource())));
  app = await Promise.resolve(createApp(container));
});

const usedEmails = new Set<string>();

const hmacOf = (email: string) =>
  createHmac('sha256', HMAC_SECRET).update(email.trim().toLowerCase()).digest('hex');

const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');

afterAll(async () => {
  const emails = [...usedEmails];
  const db = testPrisma();
  await db.$executeRaw`DELETE FROM auth_user WHERE email = ANY(${emails}::text[])`;
  await db.$executeRaw`DELETE FROM email_outbox WHERE to_address = ANY(${emails}::text[])`;
  await db.$executeRaw`
    DELETE FROM email_send_log WHERE email_hmac = ANY(${emails.map(hmacOf)}::text[])`;
  await db.$executeRaw`
    DELETE FROM login_throttle WHERE email_hmac = ANY(${emails.map(hmacOf)}::text[])`;
  await disconnectTestPrisma();
  await container.prisma.$disconnect();
});

function freshEmail(): string {
  const email = `${randomUUID()}@http-auth.test`;
  usedEmails.add(email);
  return email;
}

const post = (path: string, body: object, cookie?: string) => {
  const req = request(app).post(path).set('Origin', WEB_ORIGIN);
  if (cookie !== undefined) req.set('Cookie', cookie);
  return req.send(body);
};

const setCookiesOf = (res: { headers: Record<string, unknown> }): string[] => {
  const raw = res.headers['set-cookie'];
  if (typeof raw === 'string') return [raw];
  if (!Array.isArray(raw)) return [];
  return raw.filter((c): c is string => typeof c === 'string');
};

const sessionSetCookie = (res: { headers: Record<string, unknown> }): string | undefined =>
  setCookiesOf(res).find((c) => c.startsWith(`${COOKIE_NAME}=`));

const ticketSetCookie = (res: { headers: Record<string, unknown> }): string | undefined =>
  setCookiesOf(res).find((c) => c.startsWith(`${TICKET_COOKIE}=`));

/** The `name=value` pair of the ticket cookie the sign-up sets, ready for a `Cookie` header. */
const ticketCookieOf = (res: { headers: Record<string, unknown> }): string => {
  const header = ticketSetCookie(res);
  if (header === undefined) throw new Error('the response sets no ticket cookie');
  return header.split(';')[0] ?? '';
};

/** The lowercase attributes of a `Set-Cookie` header, without its `name=value`. */
const attributesOf = (header: string): string[] =>
  header
    .split(';')
    .slice(1)
    .map((a) => a.trim().toLowerCase());

/** The SHA-256 the server keeps of the ticket in that `name=value` pair. */
const ticketHashOf = (cookie: string): string =>
  sha256(decodeURIComponent(cookie.slice(`${TICKET_COOKIE}=`.length)));

/** The `name=value` pair of the session cookie the response sets, ready for a `Cookie` header. */
const sessionCookieOf = (res: { headers: Record<string, unknown> }): string => {
  const header = sessionSetCookie(res);
  if (header === undefined) throw new Error('the response sets no session cookie');
  return header.split(';')[0] ?? '';
};

const tokenIn = (link: string | null): string => {
  const match = /[A-Za-z0-9_-]{43}/.exec(link ?? '');
  if (!match) throw new Error(`no token in link ${String(link)}`);
  return match[0];
};

async function latestLink(email: string, kind: 'confirm' | 'reset'): Promise<string> {
  const rows = await testPrisma().$queryRaw<{ link: string | null }[]>`
    SELECT payload->>'link' AS link FROM email_outbox
    WHERE to_address = ${email} AND kind = ${kind}::email_kind
    ORDER BY created_at DESC, id DESC LIMIT 1`;
  const row = rows[0];
  if (row === undefined) throw new Error(`no ${kind} email for ${email}`);
  return tokenIn(row.link);
}

async function userIdOf(email: string): Promise<string> {
  const rows = await testPrisma().$queryRaw<{ id: string }[]>`
    SELECT id::text AS id FROM auth_user WHERE email = ${email}`;
  const row = rows[0];
  if (row === undefined) throw new Error(`no user for ${email}`);
  return row.id;
}

async function sessionCount(userId: string): Promise<number> {
  const rows = await testPrisma().$queryRaw<{ n: number }[]>`
    SELECT count(*)::int AS n FROM auth_session WHERE user_id = ${userId}::uuid`;
  return rows[0]?.n ?? 0;
}

async function outboxCount(email: string, kind: string): Promise<number> {
  const rows = await testPrisma().$queryRaw<{ n: number }[]>`
    SELECT count(*)::int AS n FROM email_outbox
    WHERE to_address = ${email} AND kind = ${kind}::email_kind`;
  return rows[0]?.n ?? 0;
}

const signUp = (email: string, password = PASSWORD) =>
  post('/api/auth/sign-up', { name: 'Ana Pérez', email, password, acceptTerms: true });

/** `POST /api/auth/confirmation/status` without a body, with the cookies of the browser. */
const confirmationStatus = (cookie?: string) => {
  const req = request(app).post('/api/auth/confirmation/status').set('Origin', WEB_ORIGIN);
  if (cookie !== undefined) req.set('Cookie', cookie);
  return req;
};

/** An account registered with `PASSWORD` that never confirmed its email; `ticket` is its cookie. */
async function pendingAccount(): Promise<{ email: string; userId: string; ticket: string }> {
  const email = freshEmail();
  const res = await signUp(email);
  expect(res.status).toBe(202);
  return { email, userId: await userIdOf(email), ticket: ticketCookieOf(res) };
}

/** A confirmed account with `PASSWORD`; `cookie` is the session its ticket opened. */
async function activeAccount(): Promise<{ email: string; userId: string; cookie: string }> {
  const { email, userId, ticket } = await pendingAccount();
  const confirmed = await post('/api/auth/confirm', { token: await latestLink(email, 'confirm') });
  expect(confirmed.status).toBe(200);
  const res = await confirmationStatus(ticket);
  expect(res.status).toBe(200);
  return { email, userId, cookie: sessionCookieOf(res) };
}

async function signIn(email: string, password = PASSWORD) {
  return post('/api/auth/sign-in', { email, password });
}

const withoutTraceId = (body: unknown): unknown => {
  if (typeof body !== 'object' || body === null) return body;
  const copy = { ...(body as Record<string, unknown>) };
  delete copy['traceId'];
  return copy;
};

const p95 = (samples: number[]): number => {
  const sorted = [...samples].sort((a, b) => a - b);
  return sorted[Math.ceil(sorted.length * 0.95) - 1] ?? Number.NaN;
};

const timed = async <T>(fn: () => Promise<T>): Promise<{ ms: number; value: T }> => {
  const started = performance.now();
  const value = await fn();
  return { ms: performance.now() - started, value };
};

describe('POST /api/auth/sign-up', () => {
  it('RF-M1-03 un correo nuevo responde 202 {status: check_email} y deja el correo de confirmación', async () => {
    const email = freshEmail();

    const res = await signUp(email);

    expect(res.status).toBe(202);
    expect(res.body).toEqual({ status: 'check_email' });
    expect(await outboxCount(email, 'confirm')).toBe(1);
  });

  it('RF-M1-03 un correo sin confirmar responde el mismo 202 {status: check_email}', async () => {
    const { email } = await pendingAccount();

    const res = await signUp(email);

    expect(res.status).toBe(202);
    expect(res.body).toEqual({ status: 'check_email' });
  });

  it('RF-M1-03 un correo activo responde el mismo 202 {status: check_email} sin abrir sesión', async () => {
    const { email } = await activeAccount();

    const res = await signUp(email);

    expect(res.status).toBe(202);
    expect(res.body).toEqual({ status: 'check_email' });
    expect(sessionSetCookie(res)).toBeUndefined();
  });

  it('TASK-059 sign-up no abre sesión: la respuesta no trae la cookie', async () => {
    const res = await signUp(freshEmail());

    expect(res.status).toBe(202);
    expect(sessionSetCookie(res)).toBeUndefined();
  });

  it('RNF-15 sign-up fija la cookie del ticket con los mismos atributos con un correo nuevo, uno Sin confirmar y uno Activo', async () => {
    const active = await activeAccount();
    const pending = await pendingAccount();

    const responses = [
      await signUp(freshEmail()),
      await signUp(pending.email),
      await signUp(active.email),
    ];

    const values = new Set<string>();
    for (const res of responses) {
      expect(res.status).toBe(202);
      expect(res.body).toEqual({ status: 'check_email' });
      const header = ticketSetCookie(res);
      expect(header).toBeDefined();
      const attributes = attributesOf(header ?? '');
      expect(attributes).toContain('httponly');
      expect(attributes).toContain('secure');
      expect(attributes).toContain('samesite=lax');
      expect(attributes).toContain('path=/api/auth');
      expect(attributes).toContain('max-age=86400');
      values.add(ticketCookieOf(res));
    }
    expect(values.size).toBe(3);
  });

  it('RNF-15 el ticket viaja solo en la cookie, nunca en el cuerpo del sign-up', async () => {
    const res = await signUp(freshEmail());

    const value = decodeURIComponent(ticketCookieOf(res).slice(`${TICKET_COOKIE}=`.length));
    expect(value.length).toBeGreaterThanOrEqual(43);
    expect(res.text).not.toContain(value);
  });

  it('TASK-059 sign-up sin aceptar los términos responde 400 VALIDATION_ERROR', async () => {
    const res = await post('/api/auth/sign-up', {
      name: 'Ana Pérez',
      email: freshEmail(),
      password: PASSWORD,
      acceptTerms: false,
    });

    expect(res.status).toBe(400);
    expect(problem(res).code).toBe('VALIDATION_ERROR');
    expect(res.headers['content-type']).toMatch(/application\/problem\+json/);
  });

  it('TASK-059 sign-up con una contraseña de menos de 8 caracteres responde 400 VALIDATION_ERROR', async () => {
    const res = await signUp(freshEmail(), 'corta');

    expect(res.status).toBe(400);
    expect(problem(res).code).toBe('VALIDATION_ERROR');
  });

  it('TASK-059 sign-up con un correo inválido responde 400 VALIDATION_ERROR', async () => {
    const res = await post('/api/auth/sign-up', {
      name: 'Ana Pérez',
      email: 'no-es-un-correo',
      password: PASSWORD,
      acceptTerms: true,
    });

    expect(res.status).toBe(400);
    expect(problem(res).code).toBe('VALIDATION_ERROR');
  });
});

describe('POST /api/auth/sign-in', () => {
  it('TASK-059 con la contraseña correcta de una cuenta activa responde 200 {me, next} y la cookie', async () => {
    const { email, userId } = await activeAccount();

    const res = await signIn(email);

    expect(res.status).toBe(200);
    const body = res.body as SignInBody;
    const me = MeDto.parse(body.me);
    expect(me.id).toBe(userId);
    expect(me.email).toBe(email);
    expect(me.name).toBe('Ana Pérez');
    expect(['onboarding', 'dashboard']).toContain(body.next);
    expect(sessionSetCookie(res)).toBeDefined();
  });

  it('TASK-059 la cookie de sesión es HttpOnly, Secure y SameSite=Lax', async () => {
    const { email } = await activeAccount();

    const res = await signIn(email);

    expect(res.status).toBe(200);
    const header = sessionSetCookie(res) ?? '';
    const attributes = header
      .split(';')
      .slice(1)
      .map((a) => a.trim().toLowerCase());
    expect(attributes).toContain('httponly');
    expect(attributes).toContain('secure');
    expect(attributes).toContain('samesite=lax');
  });

  it('TASK-059 la cookie de sign-in abre una sesión que las rutas con sesión aceptan', async () => {
    const { email } = await activeAccount();
    const cookie = sessionCookieOf(await signIn(email));

    const res = await post('/api/auth/sign-out', {}, cookie);

    expect(res.status).toBe(204);
  });

  it('RNF-15 una contraseña incorrecta responde 401 INVALID_CREDENTIALS sin cookie', async () => {
    const { email } = await activeAccount();

    const res = await signIn(email, WRONG_PASSWORD);

    expect(res.status).toBe(401);
    expect(problem(res).code).toBe('INVALID_CREDENTIALS');
    expect(sessionSetCookie(res)).toBeUndefined();
  });

  it('RNF-15 un correo sin cuenta responde el mismo 401 INVALID_CREDENTIALS que una contraseña incorrecta', async () => {
    const { email } = await activeAccount();

    const wrongPassword = await signIn(email, WRONG_PASSWORD);
    const noAccount = await signIn(freshEmail(), WRONG_PASSWORD);

    expect(noAccount.status).toBe(401);
    expect(problem(noAccount).code).toBe('INVALID_CREDENTIALS');
    expect(withoutTraceId(noAccount.body)).toEqual(withoutTraceId(wrongPassword.body));
  });

  it('TASK-059 una cuenta sin confirmar con la contraseña correcta responde 403 EMAIL_NOT_CONFIRMED sin sesión', async () => {
    const { email, userId } = await pendingAccount();

    const res = await signIn(email);

    expect(res.status).toBe(403);
    expect(problem(res).code).toBe('EMAIL_NOT_CONFIRMED');
    expect(sessionSetCookie(res)).toBeUndefined();
    expect(await sessionCount(userId)).toBe(0);
  });

  it('TASK-059 tras 5 fallos seguidos responde 429 LOGIN_LOCKED con retryAfterSeconds', async () => {
    const { email } = await activeAccount();
    for (let i = 0; i < 5; i += 1) {
      expect((await signIn(email, WRONG_PASSWORD)).status).toBe(401);
    }

    const res = await signIn(email);

    expect(res.status).toBe(429);
    expect(problem(res).code).toBe('LOGIN_LOCKED');
    const seconds = problem(res).data?.['retryAfterSeconds'];
    expect(typeof seconds).toBe('number');
    expect(seconds as number).toBeGreaterThan(0);
    expect(seconds as number).toBeLessThanOrEqual(60);
    expect(sessionSetCookie(res)).toBeUndefined();
  });

  it('TASK-059 sign-in sin contraseña responde 400 VALIDATION_ERROR', async () => {
    const res = await post('/api/auth/sign-in', { email: freshEmail() });

    expect(res.status).toBe(400);
    expect(problem(res).code).toBe('VALIDATION_ERROR');
  });
});

describe('POST /api/auth/confirmation/resend', () => {
  it('TASK-059 con el correo de una cuenta sin confirmar responde 202', async () => {
    const { email } = await pendingAccount();

    const res = await post('/api/auth/confirmation/resend', { email });

    expect(res.status).toBe(202);
  });

  it('TASK-059 con un correo sin cuenta responde el mismo 202', async () => {
    const res = await post('/api/auth/confirmation/resend', { email: freshEmail() });

    expect(res.status).toBe(202);
  });

  it('TASK-059 con el token de un enlace responde 202', async () => {
    const { email } = await pendingAccount();
    const token = await latestLink(email, 'confirm');

    const res = await post('/api/auth/confirmation/resend', { token });

    expect(res.status).toBe(202);
  });

  it('TASK-059 con un token desconocido responde 202', async () => {
    const res = await post('/api/auth/confirmation/resend', { token: UNKNOWN_TOKEN });

    expect(res.status).toBe(202);
  });

  it('TASK-059 resend sin correo ni token responde 400 VALIDATION_ERROR', async () => {
    const res = await post('/api/auth/confirmation/resend', {});

    expect(res.status).toBe(400);
    expect(problem(res).code).toBe('VALIDATION_ERROR');
  });
});

describe('POST /api/auth/confirm', () => {
  it('RF-M1-18 un enlace vigente responde 200 {status: confirmed} sin cookie de sesión ni fila en auth_session', async () => {
    const { email, userId } = await pendingAccount();

    const res = await post('/api/auth/confirm', { token: await latestLink(email, 'confirm') });

    expect(res.status).toBe(200);
    expect(ConfirmDto.parse(res.body)).toEqual({ status: 'confirmed' });
    expect(res.body).toEqual({ status: 'confirmed' });
    expect(sessionSetCookie(res)).toBeUndefined();
    expect(await sessionCount(userId)).toBe(0);
  });

  it('TASK-059 un enlace ya usado responde 409 LINK_ALREADY_USED', async () => {
    const { email } = await pendingAccount();
    const token = await latestLink(email, 'confirm');
    expect((await post('/api/auth/confirm', { token })).status).toBe(200);

    const res = await post('/api/auth/confirm', { token });

    expect(res.status).toBe(409);
    expect(problem(res).code).toBe('LINK_ALREADY_USED');
    expect(sessionSetCookie(res)).toBeUndefined();
  });

  it('TASK-059 un token desconocido responde 410 LINK_INVALID con canResend', async () => {
    const res = await post('/api/auth/confirm', { token: UNKNOWN_TOKEN });

    expect(res.status).toBe(410);
    expect(problem(res).code).toBe('LINK_INVALID');
    expect(problem(res).data?.['canResend']).toBe(false);
    expect(sessionSetCookie(res)).toBeUndefined();
  });

  it('TASK-059 un enlace vencido de una cuenta sin confirmar responde 410 LINK_INVALID con canResend true', async () => {
    const { email } = await pendingAccount();
    const token = await latestLink(email, 'confirm');
    await testPrisma().$executeRaw`
      UPDATE email_link SET expires_at = now() - interval '1 minute'
      WHERE token_hash = ${sha256(token)}`;

    const res = await post('/api/auth/confirm', { token });

    expect(res.status).toBe(410);
    expect(problem(res).code).toBe('LINK_INVALID');
    expect(problem(res).data?.['canResend']).toBe(true);
  });

  it('RF-M1-18 confirmar con la cookie de otra sesión en el dispositivo no la toca ni abre otra', async () => {
    const other = await activeAccount();
    expect(await sessionCount(other.userId)).toBe(1);
    const { email, userId } = await pendingAccount();

    const res = await post(
      '/api/auth/confirm',
      { token: await latestLink(email, 'confirm') },
      other.cookie,
    );

    expect(res.status).toBe(200);
    expect(sessionSetCookie(res)).toBeUndefined();
    expect(await sessionCount(other.userId)).toBe(1);
    expect(await sessionCount(userId)).toBe(0);
    expect((await post('/api/auth/sign-out', {}, other.cookie)).status).toBe(204);
  });

  it('TASK-059 confirm con un token corto responde 400 VALIDATION_ERROR', async () => {
    const res = await post('/api/auth/confirm', { token: 'corto' });

    expect(res.status).toBe(400);
    expect(problem(res).code).toBe('VALIDATION_ERROR');
  });
});

describe('POST /api/auth/confirmation/status', () => {
  it('RF-M1-18 La pestaña de registro continúa sola al confirmar el correo: pending antes del enlace, después confirmed con la cookie de sesión y next onboarding', async () => {
    const { email, userId, ticket } = await pendingAccount();

    const before = await confirmationStatus(ticket);
    expect(before.status).toBe(200);
    expect(ConfirmationStatusDto.parse(before.body)).toEqual({ status: 'pending' });
    expect(sessionSetCookie(before)).toBeUndefined();

    const link = await post('/api/auth/confirm', { token: await latestLink(email, 'confirm') });
    expect(link.status).toBe(200);

    const after = await confirmationStatus(ticket);
    expect(after.status).toBe(200);
    expect(ConfirmationStatusDto.parse(after.body)).toEqual({
      status: 'confirmed',
      next: 'onboarding',
    });
    const attributes = attributesOf(sessionSetCookie(after) ?? '');
    expect(attributes).toContain('httponly');
    expect(attributes).toContain('secure');
    expect(attributes).toContain('samesite=lax');
    expect(await sessionCount(userId)).toBe(1);
    const me = await request(app).get('/api/me').set('Cookie', sessionCookieOf(after));
    expect(me.status).toBe(200);
    expect(MeDto.parse(me.body).id).toBe(userId);
  });

  it('RF-M1-18 al abrir la sesión borra la cookie del ticket', async () => {
    const { email, ticket } = await pendingAccount();
    await post('/api/auth/confirm', { token: await latestLink(email, 'confirm') });

    const res = await confirmationStatus(ticket);

    expect(res.status).toBe(200);
    const header = ticketSetCookie(res);
    expect(header).toBeDefined();
    const attributes = attributesOf(header ?? '');
    expect(attributes).toContain('path=/api/auth');
    const expires = attributes.find((a) => a.startsWith('expires='))?.slice('expires='.length);
    const cleared =
      attributes.includes('max-age=0') ||
      (expires !== undefined && new Date(expires).getTime() <= Date.now());
    expect(cleared).toBe(true);
  });

  it('RF-M1-18 sin la cookie del ticket responde 200 {status: pending}', async () => {
    const res = await confirmationStatus();

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: 'pending' });
    expect(sessionSetCookie(res)).toBeUndefined();
  });

  it('RF-M1-18 el ticket sirve una sola vez: la segunda llamada responde pending', async () => {
    const { email, userId, ticket } = await pendingAccount();
    await post('/api/auth/confirm', { token: await latestLink(email, 'confirm') });
    expect((await confirmationStatus(ticket)).body).toMatchObject({ status: 'confirmed' });

    const res = await confirmationStatus(ticket);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: 'pending' });
    expect(sessionSetCookie(res)).toBeUndefined();
    expect(await sessionCount(userId)).toBe(1);
  });

  it('RF-M1-18 un ticket vencido (más de 24 h) responde pending aunque se abra el enlace', async () => {
    const { email, userId, ticket } = await pendingAccount();
    await testPrisma().$executeRaw`
      UPDATE signup_ticket SET expires_at = now() - interval '1 minute'
      WHERE token_hash = ${ticketHashOf(ticket)}`;
    await post('/api/auth/confirm', { token: await latestLink(email, 'confirm') });

    const res = await confirmationStatus(ticket);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: 'pending' });
    expect(sessionSetCookie(res)).toBeUndefined();
    expect(await sessionCount(userId)).toBe(0);
  });

  it('RNF-15 con el ticket de un correo Activo responde pending siempre, igual que un ticket inexistente', async () => {
    const active = await activeAccount();
    const ticket = ticketCookieOf(await signUp(active.email));

    const first = await confirmationStatus(ticket);
    const second = await confirmationStatus(ticket);
    const unknown = await confirmationStatus(`${TICKET_COOKIE}=${UNKNOWN_TOKEN}`);

    for (const res of [first, second, unknown]) {
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ status: 'pending' });
      expect(sessionSetCookie(res)).toBeUndefined();
    }
    expect(first.text).toBe(unknown.text);
    expect(await sessionCount(active.userId)).toBe(1);
  });

  it('EC-M1-14 EC-M1-09 registrarse de nuevo con el correo deja el ticket anterior en pending aunque se abra el enlace nuevo', async () => {
    const { email, userId, ticket: old } = await pendingAccount();
    const fresh = ticketCookieOf(await signUp(email));
    await post('/api/auth/confirm', { token: await latestLink(email, 'confirm') });

    const stale = await confirmationStatus(old);
    expect(stale.body).toEqual({ status: 'pending' });
    expect(await sessionCount(userId)).toBe(0);

    const opened = await confirmationStatus(fresh);
    expect(opened.body).toEqual({ status: 'confirmed', next: 'onboarding' });
    expect(await sessionCount(userId)).toBe(1);
  });

  it('EC-M1-14 EC-M1-10 recuperar la contraseña de la cuenta Sin confirmar deja su ticket en pending', async () => {
    const { email, userId, ticket } = await pendingAccount();
    expect((await post('/api/auth/password/forgot', { email })).status).toBe(202);
    const reset = await post('/api/auth/password/reset', {
      token: await latestLink(email, 'reset'),
      newPassword: NEW_PASSWORD,
    });
    expect(reset.status).toBe(200);

    const res = await confirmationStatus(ticket);

    expect(res.body).toEqual({ status: 'pending' });
    expect(sessionSetCookie(res)).toBeUndefined();
    expect(await sessionCount(userId)).toBe(1);
  });

  it('EC-M1-11 si el navegador del ticket tiene la sesión de otro usuario, la cierra y abre la del usuario confirmado', async () => {
    const other = await activeAccount();
    const { email, userId, ticket } = await pendingAccount();
    await post('/api/auth/confirm', { token: await latestLink(email, 'confirm') });

    const res = await confirmationStatus(`${ticket}; ${other.cookie}`);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: 'confirmed', next: 'onboarding' });
    expect(await sessionCount(other.userId)).toBe(0);
    expect(await sessionCount(userId)).toBe(1);
    const me = await request(app).get('/api/me').set('Cookie', sessionCookieOf(res));
    expect(MeDto.parse(me.body).id).toBe(userId);
    const stale = await post('/api/auth/sign-out', {}, other.cookie);
    expect(stale.status).toBe(401);
  });

  it('EC-M1-11 mientras el ticket esté pendiente la sesión del otro usuario sigue abierta', async () => {
    const other = await activeAccount();
    const { ticket } = await pendingAccount();

    const res = await confirmationStatus(`${ticket}; ${other.cookie}`);

    expect(res.body).toEqual({ status: 'pending' });
    expect(await sessionCount(other.userId)).toBe(1);
  });

  it('RF-M1-04 una cuenta sin confirmar sigue sin sesión ni acceso a datos, con o sin ticket', async () => {
    const { userId, ticket } = await pendingAccount();

    const status = await confirmationStatus(ticket);
    const withTicket = await request(app).get('/api/me').set('Cookie', ticket);
    const withoutTicket = await request(app).get('/api/me');

    expect(status.body).toEqual({ status: 'pending' });
    expect(sessionSetCookie(status)).toBeUndefined();
    expect(withTicket.status).toBe(401);
    expect(problem(withTicket).code).toBe('SESSION_EXPIRED');
    expect(withoutTicket.status).toBe(401);
    expect(await sessionCount(userId)).toBe(0);
  });

  it('TASK-265 confirmation/status desde otro origen responde 403 y no abre la sesión', async () => {
    const { email, userId, ticket } = await pendingAccount();
    await post('/api/auth/confirm', { token: await latestLink(email, 'confirm') });

    const res = await request(app)
      .post('/api/auth/confirmation/status')
      .set('Origin', 'https://otro-sitio.example')
      .set('Cookie', ticket);

    expect(res.status).toBe(403);
    expect(sessionSetCookie(res)).toBeUndefined();
    expect(await sessionCount(userId)).toBe(0);
    expect((await confirmationStatus(ticket)).body).toMatchObject({ status: 'confirmed' });
  });
});

describe('POST /api/auth/password/forgot', () => {
  it('RF-M1-03 un correo con cuenta responde 202 y deja el correo de recuperación', async () => {
    const { email } = await activeAccount();

    const res = await post('/api/auth/password/forgot', { email });

    expect(res.status).toBe(202);
    expect(await outboxCount(email, 'reset')).toBe(1);
  });

  it('RF-M1-03 un correo sin cuenta responde el mismo estado y cuerpo que uno con cuenta', async () => {
    const { email } = await activeAccount();

    const existing = await post('/api/auth/password/forgot', { email });
    const missing = await post('/api/auth/password/forgot', { email: freshEmail() });

    expect(missing.status).toBe(202);
    expect(missing.status).toBe(existing.status);
    expect(missing.body).toEqual(existing.body);
    expect(missing.text).toBe(existing.text);
  });

  it('TASK-059 forgot con un correo inválido responde 400 VALIDATION_ERROR', async () => {
    const res = await post('/api/auth/password/forgot', { email: 'no-es-un-correo' });

    expect(res.status).toBe(400);
    expect(problem(res).code).toBe('VALIDATION_ERROR');
  });
});

describe('POST /api/auth/password/reset', () => {
  it('TASK-059 un enlace vigente responde 200 {next} y la cookie, cierra las demás sesiones y deja entrar con la nueva contraseña', async () => {
    const { email, userId } = await activeAccount();
    await signIn(email);
    expect(await sessionCount(userId)).toBe(2);
    expect((await post('/api/auth/password/forgot', { email })).status).toBe(202);

    const res = await post('/api/auth/password/reset', {
      token: await latestLink(email, 'reset'),
      newPassword: NEW_PASSWORD,
    });

    expect(res.status).toBe(200);
    expect(['onboarding', 'dashboard']).toContain((res.body as { next?: unknown }).next);
    expect(sessionSetCookie(res)).toBeDefined();
    expect(await sessionCount(userId)).toBe(1);
    expect((await signIn(email, PASSWORD)).status).toBe(401);
    expect((await signIn(email, NEW_PASSWORD)).status).toBe(200);
  });

  it('TASK-059 un token desconocido responde 410 LINK_INVALID', async () => {
    const res = await post('/api/auth/password/reset', {
      token: UNKNOWN_TOKEN,
      newPassword: NEW_PASSWORD,
    });

    expect(res.status).toBe(410);
    expect(problem(res).code).toBe('LINK_INVALID');
    expect(sessionSetCookie(res)).toBeUndefined();
  });

  it('TASK-059 un enlace ya usado responde 410 LINK_INVALID', async () => {
    const { email } = await activeAccount();
    await post('/api/auth/password/forgot', { email });
    const token = await latestLink(email, 'reset');
    expect(
      (await post('/api/auth/password/reset', { token, newPassword: NEW_PASSWORD })).status,
    ).toBe(200);

    const res = await post('/api/auth/password/reset', { token, newPassword: PASSWORD });

    expect(res.status).toBe(410);
    expect(problem(res).code).toBe('LINK_INVALID');
  });

  it('TASK-059 reset con una contraseña nueva de menos de 8 caracteres responde 400 VALIDATION_ERROR', async () => {
    const res = await post('/api/auth/password/reset', {
      token: UNKNOWN_TOKEN,
      newPassword: 'corta',
    });

    expect(res.status).toBe(400);
    expect(problem(res).code).toBe('VALIDATION_ERROR');
  });
});

describe('POST /api/auth/password/change', () => {
  it('TASK-059 con la contraseña actual correcta responde 204 y cierra las demás sesiones', async () => {
    const { email, userId, cookie } = await activeAccount();
    await signIn(email);
    expect(await sessionCount(userId)).toBe(2);

    const res = await post(
      '/api/auth/password/change',
      { currentPassword: PASSWORD, newPassword: NEW_PASSWORD },
      cookie,
    );

    expect(res.status).toBe(204);
    expect(await sessionCount(userId)).toBe(1);
    expect((await signIn(email, NEW_PASSWORD)).status).toBe(200);
  });

  it('TASK-059 con la contraseña actual incorrecta responde 401 INVALID_CURRENT_PASSWORD', async () => {
    const { cookie } = await activeAccount();

    const res = await post(
      '/api/auth/password/change',
      { currentPassword: WRONG_PASSWORD, newPassword: NEW_PASSWORD },
      cookie,
    );

    expect(res.status).toBe(401);
    expect(problem(res).code).toBe('INVALID_CURRENT_PASSWORD');
  });

  it('TASK-059 sin sesión responde 401 SESSION_EXPIRED', async () => {
    const res = await post('/api/auth/password/change', {
      currentPassword: PASSWORD,
      newPassword: NEW_PASSWORD,
    });

    expect(res.status).toBe(401);
    expect(problem(res).code).toBe('SESSION_EXPIRED');
  });

  it('TASK-059 change con una contraseña nueva de menos de 8 caracteres responde 400 VALIDATION_ERROR', async () => {
    const { cookie } = await activeAccount();

    const res = await post(
      '/api/auth/password/change',
      { currentPassword: PASSWORD, newPassword: 'corta' },
      cookie,
    );

    expect(res.status).toBe(400);
    expect(problem(res).code).toBe('VALIDATION_ERROR');
  });
});

describe('POST /api/auth/sign-out y /api/auth/sign-out-all', () => {
  it('TASK-059 sign-out responde 204 y borra solo la sesión actual', async () => {
    const { email, userId, cookie } = await activeAccount();
    const second = sessionCookieOf(await signIn(email));
    expect(await sessionCount(userId)).toBe(2);

    const res = await post('/api/auth/sign-out', {}, cookie);

    expect(res.status).toBe(204);
    expect(await sessionCount(userId)).toBe(1);
    expect((await post('/api/auth/sign-out', {}, cookie)).status).toBe(401);
    expect((await post('/api/auth/sign-out', {}, second)).status).toBe(204);
  });

  it('TASK-059 sign-out-all responde 204 y borra todas las sesiones del usuario', async () => {
    const { email, userId, cookie } = await activeAccount();
    const second = sessionCookieOf(await signIn(email));
    expect(await sessionCount(userId)).toBe(2);

    const res = await post('/api/auth/sign-out-all', {}, cookie);

    expect(res.status).toBe(204);
    expect(await sessionCount(userId)).toBe(0);
    const after = await post('/api/auth/sign-out', {}, second);
    expect(after.status).toBe(401);
    expect(problem(after).code).toBe('SESSION_EXPIRED');
  });

  it('TASK-059 sign-out sin sesión responde 401 SESSION_EXPIRED', async () => {
    const res = await post('/api/auth/sign-out', {});

    expect(res.status).toBe(401);
    expect(problem(res).code).toBe('SESSION_EXPIRED');
  });

  it('TASK-059 sign-out-all sin sesión responde 401 SESSION_EXPIRED', async () => {
    const res = await post('/api/auth/sign-out-all', {});

    expect(res.status).toBe(401);
    expect(problem(res).code).toBe('SESSION_EXPIRED');
  });
});

describe('RNF-15 tiempos iguales con correos existentes e inexistentes', () => {
  const SAMPLES = 50;
  const MAX_P95_GAP_MS = 50;

  it(
    'RNF-15 sign-up da el mismo cuerpo y estado con correos existentes e inexistentes, con una diferencia p95 < 50 ms en 50 muestras',
    async () => {
      const active = await activeAccount();
      const pending = await pendingAccount();
      // Warm-up: the first requests pay one-off costs (connections, the dummy hash).
      await signUp(freshEmail());
      await signUp(active.email);

      const existing: number[] = [];
      const missing: number[] = [];
      const reference = { status: 202, body: { status: 'check_email' } };
      for (let i = 0; i < SAMPLES; i += 1) {
        const target = i % 2 === 0 ? active.email : pending.email;
        const a = await timed(() => signUp(target));
        const b = await timed(() => signUp(freshEmail()));
        expect({ status: a.value.status, body: a.value.body as unknown }).toEqual(reference);
        expect({ status: b.value.status, body: b.value.body as unknown }).toEqual(reference);
        existing.push(a.ms);
        missing.push(b.ms);
      }

      expect(Math.abs(p95(existing) - p95(missing))).toBeLessThan(MAX_P95_GAP_MS);
    },
    180_000,
  );

  it(
    'RNF-15 password/forgot da el mismo cuerpo y estado con correos existentes e inexistentes, con una diferencia p95 < 50 ms en 50 muestras',
    async () => {
      const { email } = await activeAccount();
      await post('/api/auth/password/forgot', { email });
      await post('/api/auth/password/forgot', { email: freshEmail() });

      const existing: number[] = [];
      const missing: number[] = [];
      const first = await post('/api/auth/password/forgot', { email });
      expect(first.status).toBe(202);
      for (let i = 0; i < SAMPLES; i += 1) {
        const a = await timed(() => post('/api/auth/password/forgot', { email }));
        const b = await timed(() => post('/api/auth/password/forgot', { email: freshEmail() }));
        expect(a.value.status).toBe(202);
        expect(b.value.status).toBe(202);
        expect(a.value.text).toBe(first.text);
        expect(b.value.text).toBe(first.text);
        existing.push(a.ms);
        missing.push(b.ms);
      }

      expect(Math.abs(p95(existing) - p95(missing))).toBeLessThan(MAX_P95_GAP_MS);
    },
    120_000,
  );
});
