import { createHmac, randomUUID } from 'node:crypto';
import { inspect } from 'node:util';

import type { Express } from 'express';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { buildContainer, createApp, type Container } from '../../src/composition/container.js';
import { parseEnv } from '../../src/infrastructure/config/env.js';
import { createApp as createBareApp } from '../../src/presentation/app.js';
import { disconnectTestPrisma, testPrisma } from '../integration/setup/db.js';

/**
 * What the API writes to its logs (plan §3.9, §5.3; RNF-17, constitution §4). The flows that carry
 * secrets run through the app the composition root builds (`buildContainer(env)` and
 * `createApp(container)`) over the test database with fake integrations: sign-up and confirmation,
 * sign-in, password recovery and account deletion. Everything written to `console` while they run
 * is captured, and none of the secrets the flow handled may appear in it: passwords, the tokens of
 * the links, the session cookie and the secrets of the environment. The plan fixes what is
 * logged: `traceId`, the route, the status and the duration.
 */
const WEB_ORIGIN = 'http://localhost:5173';
const COOKIE_NAME = '__Secure-better-auth.session_token';
const HMAC_SECRET = 'hmac-secret-value-0123456789abcdef0123456789';
const AUTH_SECRET = 'auth-secret-value-0123456789abcdef0123456789';
const JOBS_SECRET = 'jobs-secret-value-0123456789abcdef0123456789';
const RESEND_API_KEY = 're_resend-key-value-0123456789';
const PASSWORD = 'Clave-segura-123-sigilo';
const NEW_PASSWORD = 'Clave-nueva-456-reservada';
const CHANGED_PASSWORD = 'Clave-cambiada-789-oculta';
const WRONG_PASSWORD = 'Clave-incorrecta-999-secreta';

const envSource = (): Record<string, string> => ({
  NODE_ENV: 'test',
  PORT: '3000',
  DATABASE_URL: process.env['TEST_DATABASE_URL'] ?? '',
  AUTH_SECRET,
  HMAC_SECRET,
  JOBS_SECRET,
  RESEND_API_KEY,
  RELEASE: '1.0',
  WEB_ORIGIN,
  INTEGRATIONS: 'fake',
});

interface Problem {
  code?: string;
  status?: number;
  traceId?: string;
}
const problem = (res: { body: unknown }) => res.body as Problem;

let container: Container;
let app: Express;
const usedEmails = new Set<string>();

const hmacOf = (email: string) =>
  createHmac('sha256', HMAC_SECRET).update(email.trim().toLowerCase()).digest('hex');

beforeAll(async () => {
  container = await Promise.resolve(buildContainer(parseEnv(envSource())));
  app = await Promise.resolve(createApp(container));
});

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

// Everything the process writes through `console` while a test runs.
let lines: string[] = [];

const CONSOLE_METHODS = ['log', 'info', 'warn', 'error', 'debug'] as const;

beforeEach(() => {
  lines = [];
  for (const method of CONSOLE_METHODS) {
    vi.spyOn(console, method).mockImplementation((...args: unknown[]) => {
      lines.push(
        args.map((arg) => (typeof arg === 'string' ? arg : inspect(arg, { depth: 8 }))).join(' '),
      );
    });
  }
});

afterEach(() => {
  vi.restoreAllMocks();
});

const sleep = (ms: number) =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });

/** The request logs are written when each response finishes; give the last one time to land. */
const settled = async (): Promise<string> => {
  await sleep(100);
  return lines.join('\n');
};

const sessionCookieOf = (res: { headers: Record<string, unknown> }): string => {
  const raw = res.headers['set-cookie'];
  const list = typeof raw === 'string' ? [raw] : Array.isArray(raw) ? (raw as unknown[]) : [];
  const header = list.find(
    (c): c is string => typeof c === 'string' && c.startsWith(`${COOKIE_NAME}=`),
  );
  if (header === undefined) throw new Error('the response sets no session cookie');
  return header.split(';')[0] ?? '';
};

/** Every form in which a session cookie can show up: the pair, the value, its token and signature. */
const cookieSecrets = (cookie: string): string[] => {
  const encoded = cookie.slice(`${COOKIE_NAME}=`.length);
  const decoded = decodeURIComponent(encoded);
  const dot = decoded.indexOf('.');
  const token = dot === -1 ? decoded : decoded.slice(0, dot);
  const signature = dot === -1 ? '' : decoded.slice(dot + 1);
  return [cookie, encoded, decoded, token, signature].filter((value) => value.length >= 8);
};

const ENV_SECRETS = [AUTH_SECRET, HMAC_SECRET, JOBS_SECRET, RESEND_API_KEY];

const expectNoSecrets = (logs: string, secrets: string[]) => {
  expect(logs.length, 'the capture saw no log at all').toBeGreaterThan(0);
  for (const secret of [...secrets, ...ENV_SECRETS]) {
    expect(secret.length).toBeGreaterThanOrEqual(8);
    expect(logs).not.toContain(secret);
  }
  const databaseUrl = process.env['TEST_DATABASE_URL'];
  if (databaseUrl !== undefined && databaseUrl !== '') {
    expect(logs).not.toContain(databaseUrl);
  }
};

const post = (path: string, body: object, cookie?: string) => {
  const req = request(app).post(path).set('Origin', WEB_ORIGIN);
  if (cookie !== undefined) req.set('Cookie', cookie);
  return req.send(body);
};

const tokenIn = (link: string | null): string => {
  const match = /[A-Za-z0-9_-]{43}/.exec(link ?? '');
  if (!match) throw new Error(`no token in link ${String(link)}`);
  return match[0];
};

async function latestToken(email: string, kind: 'confirm' | 'reset'): Promise<string> {
  const rows = await testPrisma().$queryRaw<{ link: string | null }[]>`
    SELECT payload->>'link' AS link FROM email_outbox
    WHERE to_address = ${email} AND kind = ${kind}::email_kind
    ORDER BY created_at DESC, id DESC LIMIT 1`;
  const row = rows[0];
  if (row === undefined) throw new Error(`no ${kind} email for ${email}`);
  return tokenIn(row.link);
}

const freshEmail = (): string => {
  const email = `${randomUUID()}@http-logs.test`;
  usedEmails.add(email);
  return email;
};

/** Registers and confirms an account; returns the secrets the flow handled. */
async function register(email: string) {
  const up = await post('/api/auth/sign-up', {
    name: 'Ana Pérez',
    email,
    password: PASSWORD,
    acceptTerms: true,
  });
  expect(up.status).toBe(202);
  const token = await latestToken(email, 'confirm');
  const confirmed = await post('/api/auth/confirm', { token });
  expect(confirmed.status).toBe(200);
  return { token, cookie: sessionCookieOf(confirmed) };
}

/** The structured request lines the API writes: one JSON object per finished request. */
const requestLines = (logs: string): Record<string, unknown>[] => {
  const found: Record<string, unknown>[] = [];
  for (const line of logs.split(/\r?\n/)) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    if (typeof parsed === 'object' && parsed !== null && 'method' in parsed) {
      found.push(Object.fromEntries(Object.entries(parsed)));
    }
  }
  return found;
};

describe('RNF-17 los logs no contienen contraseñas, tokens de enlaces ni cookies', () => {
  it('RNF-17 el registro (sign-up y confirmación) no deja la contraseña, el token del enlace ni la cookie en los logs', async () => {
    const email = freshEmail();

    const { token, cookie } = await register(email);

    const logs = await settled();
    expectNoSecrets(logs, [PASSWORD, token, ...cookieSecrets(cookie)]);
    const paths = requestLines(logs).map((line) => line['path']);
    expect(paths).toContain('/api/auth/sign-up');
    expect(paths).toContain('/api/auth/confirm');
  });

  it('RNF-17 el registro de un correo que ya existe tampoco deja la contraseña en los logs', async () => {
    const email = freshEmail();
    await register(email);
    lines = [];

    const again = await post('/api/auth/sign-up', {
      name: 'Ana Pérez',
      email,
      password: NEW_PASSWORD,
      acceptTerms: true,
    });

    expect(again.status).toBe(202);
    expectNoSecrets(await settled(), [PASSWORD, NEW_PASSWORD]);
  });

  it('RNF-17 el inicio de sesión (correcto e incorrecto) no deja contraseñas ni cookies en los logs', async () => {
    const email = freshEmail();
    await register(email);
    lines = [];

    const wrong = await post('/api/auth/sign-in', { email, password: WRONG_PASSWORD });
    const missing = await post('/api/auth/sign-in', {
      email: freshEmail(),
      password: WRONG_PASSWORD,
    });
    const ok = await post('/api/auth/sign-in', { email, password: PASSWORD });

    expect(wrong.status).toBe(401);
    expect(missing.status).toBe(401);
    expect(ok.status).toBe(200);
    const logs = await settled();
    expectNoSecrets(logs, [PASSWORD, WRONG_PASSWORD, ...cookieSecrets(sessionCookieOf(ok))]);
    const statuses = requestLines(logs)
      .filter((line) => line['path'] === '/api/auth/sign-in')
      .map((line) => line['status']);
    expect(statuses).toEqual([401, 401, 200]);
  });

  it('RNF-17 tras 5 fallos seguidos el bloqueo del inicio de sesión no deja contraseñas en los logs', async () => {
    const email = freshEmail();
    await register(email);
    lines = [];

    for (let i = 0; i < 5; i += 1) {
      expect((await post('/api/auth/sign-in', { email, password: WRONG_PASSWORD })).status).toBe(
        401,
      );
    }
    const locked = await post('/api/auth/sign-in', { email, password: PASSWORD });

    expect(locked.status).toBe(429);
    expectNoSecrets(await settled(), [PASSWORD, WRONG_PASSWORD]);
  });

  it('RNF-17 la recuperación (forgot y reset) no deja las contraseñas, el token del enlace ni la cookie en los logs', async () => {
    const email = freshEmail();
    await register(email);
    lines = [];

    expect((await post('/api/auth/password/forgot', { email })).status).toBe(202);
    expect((await post('/api/auth/password/forgot', { email: freshEmail() })).status).toBe(202);
    const token = await latestToken(email, 'reset');
    const reset = await post('/api/auth/password/reset', { token, newPassword: NEW_PASSWORD });
    expect(reset.status).toBe(200);
    const again = await post('/api/auth/password/reset', { token, newPassword: PASSWORD });
    expect(again.status).toBe(410);

    const logs = await settled();
    expectNoSecrets(logs, [
      PASSWORD,
      NEW_PASSWORD,
      token,
      ...cookieSecrets(sessionCookieOf(reset)),
    ]);
    const paths = requestLines(logs).map((line) => line['path']);
    expect(paths).toContain('/api/auth/password/forgot');
    expect(paths).toContain('/api/auth/password/reset');
  });

  it('RNF-17 el cambio de contraseña no deja la actual ni la nueva en los logs', async () => {
    const email = freshEmail();
    const { cookie } = await register(email);
    lines = [];

    const wrong = await post(
      '/api/auth/password/change',
      { currentPassword: WRONG_PASSWORD, newPassword: CHANGED_PASSWORD },
      cookie,
    );
    const changed = await post(
      '/api/auth/password/change',
      { currentPassword: PASSWORD, newPassword: CHANGED_PASSWORD },
      cookie,
    );

    expect(wrong.status).toBe(401);
    expect(changed.status).toBe(204);
    expectNoSecrets(await settled(), [
      PASSWORD,
      WRONG_PASSWORD,
      CHANGED_PASSWORD,
      ...cookieSecrets(cookie),
    ]);
  });

  it('RNF-17 la eliminación de la cuenta (con la contraseña mal y bien) no deja la contraseña ni la cookie en los logs', async () => {
    const email = freshEmail();
    const { cookie } = await register(email);
    lines = [];

    const wrong = await post(
      '/api/me/delete',
      { password: WRONG_PASSWORD, confirmation: 'ELIMINAR' },
      cookie,
    );
    const deleted = await post(
      '/api/me/delete',
      { password: PASSWORD, confirmation: 'ELIMINAR' },
      cookie,
    );

    expect(wrong.status).toBeGreaterThanOrEqual(400);
    expect(deleted.status).toBeGreaterThanOrEqual(200);
    expect(deleted.status).toBeLessThan(300);
    const logs = await settled();
    expectNoSecrets(logs, [PASSWORD, WRONG_PASSWORD, ...cookieSecrets(cookie)]);
    const paths = requestLines(logs).map((line) => line['path']);
    expect(paths).toContain('/api/me/delete');
  });
});

describe('RNF-17 qué se registra de cada petición', () => {
  it('RNF-17 cada petición deja una línea con traceId, método, ruta, estado y duración, y nada más', async () => {
    const email = freshEmail();
    await register(email);

    const logs = await settled();
    const entries = requestLines(logs);
    expect(entries.length).toBeGreaterThanOrEqual(2);
    for (const entry of entries) {
      expect(Object.keys(entry).sort()).toEqual([
        'durationMs',
        'method',
        'path',
        'status',
        'traceId',
      ]);
      expect(typeof entry['traceId']).toBe('string');
      expect(typeof entry['path']).toBe('string');
      expect(typeof entry['status']).toBe('number');
      expect(typeof entry['durationMs']).toBe('number');
    }
  });

  it('RNF-17 el token de un enlace en la consulta de la ruta no se registra', async () => {
    const email = freshEmail();
    await register(email);
    await post('/api/auth/password/forgot', { email });
    const token = await latestToken(email, 'reset');
    lines = [];

    const res = await request(app).get('/api/health').query({ token, password: PASSWORD });

    expect(res.status).toBe(204);
    const logs = await settled();
    expectNoSecrets(logs, [token, PASSWORD]);
    expect(requestLines(logs).map((line) => line['path'])).toContain('/api/health');
  });

  it('RNF-17 el cuerpo de un inicio de sesión fallido no se registra', async () => {
    const email = freshEmail();
    await register(email);
    lines = [];

    await post('/api/auth/sign-in', { email, password: WRONG_PASSWORD });

    const logs = await settled();
    expect(logs).not.toContain(WRONG_PASSWORD);
    expect(logs).not.toContain(`"password"`);
  });
});

describe('RNF-17 un error provocado', () => {
  const buildFailingApp = () =>
    createBareApp({
      webOrigin: WEB_ORIGIN,
      // Runs for every request after the body is parsed; it fails with a message that carries
      // everything the request brought.
      catchUp: (req, _res, next) => {
        const body = JSON.stringify(req.body);
        next(new Error(`database exploded with ${body} and ${req.headers.cookie ?? ''}`));
      },
    });

  it('RNF-17 devuelve solo INTERNAL_ERROR y el traceId, sin mensaje ni traza', async () => {
    const token = 'T'.repeat(43);
    const cookie = `${COOKIE_NAME}=${encodeURIComponent('sesion-secreta-12345.firma-secreta-67890')}`;

    const res = await request(buildFailingApp())
      .post('/api/boom')
      .set('Origin', WEB_ORIGIN)
      .set('Cookie', cookie)
      .send({ password: PASSWORD, token });

    expect(res.status).toBe(500);
    expect(res.headers['content-type']).toMatch(/application\/problem\+json/);
    expect(problem(res).code).toBe('INTERNAL_ERROR');
    expect(problem(res).status).toBe(500);
    expect(typeof problem(res).traceId).toBe('string');
    expect(Object.keys(res.body as object).sort()).toEqual([
      'code',
      'status',
      'title',
      'traceId',
      'type',
    ]);
    expect(res.text).not.toContain('exploded');
    expect(res.text).not.toContain(PASSWORD);
    expect(res.text).not.toContain(token);
    expect(res.text).not.toContain('sesion-secreta');
    expect(res.text).not.toMatch(/\bat .*\.(ts|js):\d+/);
  });

  it('RNF-17 los logs del error guardan el traceId y el código, no la contraseña, el token ni la cookie', async () => {
    const token = 'U'.repeat(43);
    const cookie = `${COOKIE_NAME}=${encodeURIComponent('sesion-reservada-12345.firma-reservada-67890')}`;

    const res = await request(buildFailingApp())
      .post('/api/boom')
      .set('Origin', WEB_ORIGIN)
      .set('Cookie', cookie)
      .send({ password: PASSWORD, token });

    expect(res.status).toBe(500);
    const logs = await settled();
    expectNoSecrets(logs, [
      PASSWORD,
      token,
      'sesion-reservada-12345',
      'firma-reservada-67890',
      cookie,
    ]);
    expect(logs).not.toContain('exploded');
    expect(logs).toContain(problem(res).traceId ?? 'sin-traceId');
    expect(logs).toContain('INTERNAL_ERROR');
  });
});
