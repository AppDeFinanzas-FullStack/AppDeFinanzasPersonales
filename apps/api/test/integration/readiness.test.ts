import type { Express } from 'express';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { buildContainer, createApp } from '../../src/composition/container.js';
import { parseEnv } from '../../src/infrastructure/config/env.js';
import { testDatabaseUrl } from './setup/db.js';

/**
 * The plan fixes `GET /api/health/ready` (plan §4.2.2): `SELECT 1` with a 2 s limit, 204 if the
 * database answers and 503 without a body otherwise. It also fixes that the composition root builds
 * the `ReadinessProbe` with the Prisma client, but not the name of the field that hands it to the
 * presentation's `createApp`. These tests therefore go through the composition root
 * (`buildContainer(env)` + `createApp(container)`), as the running API does, and only change the
 * `DATABASE_URL` of the env.
 */

const READY_PATH = '/api/health/ready';
const HEALTH_PATH = '/api/health';

/** The criterion: an unreachable database answers in less than 3 s. */
const MAX_UNREACHABLE_MS = 3_000;

/** A fake password the 503 must never reveal. */
const FAKE_PASSWORD = 'ready-password';

/**
 * A non-routable address: the TCP connection neither opens nor gets refused, it just hangs, so only
 * the probe's 2 s limit can end the request in time.
 */
const BLACKHOLE_DATABASE_URL = `postgresql://ready:${FAKE_PASSWORD}@10.255.255.1:5432/finanzas`;

/** A local port where nothing listens: the connection is refused. */
const REFUSED_DATABASE_URL = `postgresql://ready:${FAKE_PASSWORD}@127.0.0.1:1/finanzas`;

const envSource = (databaseUrl: string): Record<string, string> => ({
  NODE_ENV: 'test',
  PORT: '3000',
  DATABASE_URL: databaseUrl,
  AUTH_SECRET: 'auth-secret-for-the-readiness-test',
  HMAC_SECRET: 'hmac-secret-for-the-readiness-test',
  JOBS_SECRET: 'jobs-secret-for-the-readiness-test',
  RESEND_API_KEY: 'resend-key-for-the-readiness-test',
  RELEASE: '1.0',
  WEB_ORIGIN: 'http://localhost:5173',
  INTEGRATIONS: 'fake',
});

/** Fragments that would reveal internals of the failed connection (constitución §4). */
const INTERNAL_DETAILS = [
  FAKE_PASSWORD,
  '10.255.255.1',
  '127.0.0.1',
  'postgresql://',
  'prisma',
  'Prisma',
  'ECONNREFUSED',
] as const;

type Container = Awaited<ReturnType<typeof buildContainer>>;

interface Built {
  container: Container;
  app: Express;
}

// The plan does not fix whether building the container or the app is synchronous.
const build = async (databaseUrl: string): Promise<Built> => {
  const container = await Promise.resolve(buildContainer(parseEnv(envSource(databaseUrl))));
  const app = await Promise.resolve(createApp(container));
  return { container, app };
};

const disconnect = async (built: Built | undefined): Promise<void> => {
  await built?.container.prisma.$disconnect();
};

const appOf = (built: Built | undefined): Express => {
  if (built === undefined) throw new Error('the app was not built');
  return built.app;
};

/** Asserts that a response carries no body at all: neither JSON nor text. */
const expectNoBody = (res: request.Response): void => {
  expect(res.text ?? '').toBe('');
  expect(res.body).toEqual({});
  expect(res.headers['content-type']).toBeUndefined();
};

describe('GET /api/health/ready con la base de test', () => {
  let built: Built | undefined;

  beforeAll(async () => {
    built = await build(testDatabaseUrl());
  });

  afterAll(async () => {
    await disconnect(built);
  });

  it('TASK-171 con la base de test GET /api/health/ready responde 204', async () => {
    const res = await request(appOf(built)).get(READY_PATH);

    expect(res.status, res.text).toBe(204);
    expectNoBody(res);
  });

  it('TASK-171 GET /api/health/ready no exige sesión', async () => {
    const res = await request(appOf(built)).get(READY_PATH).set('Cookie', '');

    expect(res.status, res.text).toBe(204);
  });

  it('TASK-171 GET /api/health sigue respondiendo 204 sin cuerpo', async () => {
    const res = await request(appOf(built)).get(HEALTH_PATH);

    expect(res.status).toBe(204);
    expectNoBody(res);
  });
});

describe.each([
  ['inalcanzable (la conexión queda colgada)', BLACKHOLE_DATABASE_URL],
  ['inalcanzable (la conexión es rechazada)', REFUSED_DATABASE_URL],
])('GET /api/health/ready con una base %s', (_label, databaseUrl) => {
  let built: Built | undefined;

  beforeAll(async () => {
    built = await build(databaseUrl);
  });

  afterAll(async () => {
    await disconnect(built);
  }, 15_000);

  it(
    'TASK-171 con una base inalcanzable responde 503 sin cuerpo y sin detalles internos en menos de 3 s',
    async () => {
      const started = Date.now();
      const res = await request(appOf(built)).get(READY_PATH);
      const elapsed = Date.now() - started;

      expect(res.status, res.text).toBe(503);
      expectNoBody(res);
      const exposed = `${JSON.stringify(res.headers)}${res.text ?? ''}`;
      for (const detail of INTERNAL_DETAILS) {
        expect(exposed).not.toContain(detail);
      }
      expect(elapsed).toBeLessThan(MAX_UNREACHABLE_MS);
    },
    10_000,
  );

  it(
    'TASK-171 GET /api/health sigue respondiendo 204 sin tocar la base aunque esté inalcanzable',
    async () => {
      const started = Date.now();
      const res = await request(appOf(built)).get(HEALTH_PATH);
      const elapsed = Date.now() - started;

      expect(res.status).toBe(204);
      expectNoBody(res);
      // Without touching the database it answers at once, far below the probe's 2 s limit.
      expect(elapsed).toBeLessThan(1_000);
    },
    10_000,
  );
});
