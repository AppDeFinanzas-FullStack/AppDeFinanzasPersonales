import { spawn, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:net';
import { fileURLToPath } from 'node:url';

import request from 'supertest';
import { afterEach, describe, expect, it } from 'vitest';

import { buildContainer, createApp } from '../../src/composition/container.js';
import { parseEnv } from '../../src/infrastructure/config/env.js';

/** Not the default dev origin, so the test shows the app takes WEB_ORIGIN from the env. */
const WEB_ORIGIN = 'http://localhost:4173';
const OTHER_ORIGIN = 'http://localhost:5173';

/** `/api/health` does not touch the database; the test database is used when it is available. */
const DATABASE_URL =
  process.env['TEST_DATABASE_URL'] ??
  'postgresql://user:db-password-xyz@localhost:5432/finanzas_test';

const SECRETS = {
  AUTH_SECRET: 'auth-secret-value-0123456789abcdef0123456789',
  HMAC_SECRET: 'hmac-secret-value-0123456789abcdef0123456789',
  JOBS_SECRET: 'jobs-secret-value-0123456789abcdef0123456789',
  RESEND_API_KEY: 're_resend-key-value-0123456789',
};

const ENV_NAMES = [
  'NODE_ENV',
  'PORT',
  'DATABASE_URL',
  'AUTH_SECRET',
  'HMAC_SECRET',
  'JOBS_SECRET',
  'RESEND_API_KEY',
  'RELEASE',
  'WEB_ORIGIN',
  'INTEGRATIONS',
];

const envSource = (overrides: Record<string, string> = {}): Record<string, string> => ({
  NODE_ENV: 'test',
  PORT: '3000',
  DATABASE_URL,
  ...SECRETS,
  RELEASE: '1.0',
  WEB_ORIGIN,
  INTEGRATIONS: 'fake',
  ...overrides,
});

interface Problem {
  code?: string;
  status?: number;
}
const problem = (res: { body: unknown }) => res.body as Problem;

// The plan does not fix whether building the container or the app is synchronous.
const buildApp = async () => {
  const container = await Promise.resolve(buildContainer(parseEnv(envSource())));
  return Promise.resolve(createApp(container));
};

describe('buildContainer y createApp', () => {
  it('TASK-036 con INTEGRATIONS=fake el contenedor arma la app y GET /api/health responde 204', async () => {
    const app = await buildApp();
    const res = await request(app).get('/api/health');
    expect(res.status).toBe(204);
    expect(res.text).toBe('');
  });

  it('TASK-036 la app del contenedor valida el Origin de las mutaciones contra el WEB_ORIGIN del env', async () => {
    const app = await buildApp();

    const own = await request(app)
      .post('/api/health')
      .set('Origin', WEB_ORIGIN)
      .set('Content-Type', 'application/json')
      .send({});
    expect([403, 415]).not.toContain(own.status);

    const foreign = await request(app)
      .post('/api/health')
      .set('Origin', OTHER_ORIGIN)
      .set('Content-Type', 'application/json')
      .send({});
    expect(foreign.status).toBe(403);
    expect(foreign.headers['content-type']).toMatch(/application\/problem\+json/);
    expect(problem(foreign).code).toBe('ORIGIN_NOT_ALLOWED');
  });
});

const API_DIR = fileURLToPath(new URL('../../', import.meta.url));
const STARTUP_TIMEOUT_MS = 30_000;
const TEST_TIMEOUT_MS = 60_000;

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

const freePort = () =>
  new Promise<number>((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address !== null ? address.port : 0;
      server.close(() => resolve(port));
    });
  });

const running: ChildProcess[] = [];

/** Runs `src/main.ts` as `pnpm start` does, with exactly the given API variables. */
const startMain = (env: Record<string, string>) => {
  const childEnv: NodeJS.ProcessEnv = { ...process.env };
  for (const name of ENV_NAMES) delete childEnv[name];
  Object.assign(childEnv, env);

  const child = spawn(process.execPath, ['--import', 'tsx', 'src/main.ts'], {
    cwd: API_DIR,
    env: childEnv,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  running.push(child);

  const chunks: string[] = [];
  child.stdout.on('data', (chunk: Buffer) => chunks.push(chunk.toString()));
  child.stderr.on('data', (chunk: Buffer) => chunks.push(chunk.toString()));
  const exited = new Promise<number | null>((resolve) => {
    child.once('exit', (code) => resolve(code));
  });
  return { output: () => chunks.join(''), exited };
};

/** Polls `/api/health` until the server answers, the process exits or the time runs out. */
const waitForHealth = async (port: number, exited: Promise<number | null>) => {
  let hasExited = false;
  void exited.then(() => {
    hasExited = true;
  });
  const deadline = Date.now() + STARTUP_TIMEOUT_MS;
  while (Date.now() < deadline && !hasExited) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/health`);
      return res.status;
    } catch {
      // Not listening yet.
    }
    await sleep(200);
  }
  return null;
};

/** Exit code of the process, or 'still running' if it does not exit in time. */
const waitForExit = (exited: Promise<number | null>) =>
  new Promise<number | null | 'still running'>((resolve) => {
    const timer = setTimeout(() => resolve('still running'), STARTUP_TIMEOUT_MS);
    void exited.then((code) => {
      clearTimeout(timer);
      resolve(code);
    });
  });

const stop = (child: ChildProcess) =>
  new Promise<void>((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) {
      resolve();
      return;
    }
    child.once('exit', () => resolve());
    child.kill();
  });

afterEach(async () => {
  await Promise.all(running.splice(0).map(stop));
});

interface InvalidEnv {
  label: string;
  /** Variable left out of the env. */
  omit?: string;
  overrides: Record<string, string>;
  /** Variable the startup error must name. */
  named: string;
}

const INVALID_ENVS: InvalidEnv[] = [
  { label: 'falta AUTH_SECRET', omit: 'AUTH_SECRET', overrides: {}, named: 'AUTH_SECRET' },
  {
    label: 'INTEGRATIONS=fake con NODE_ENV=production',
    overrides: { NODE_ENV: 'production', INTEGRATIONS: 'fake' },
    named: 'INTEGRATIONS',
  },
];

describe('main.ts', () => {
  it(
    'TASK-036 main.ts valida el env, arma el contenedor y escucha en PORT: /api/health responde 204',
    async () => {
      const port = await freePort();
      const main = startMain(envSource({ PORT: String(port) }));
      const status = await waitForHealth(port, main.exited);
      expect(status, main.output()).toBe(204);
    },
    TEST_TIMEOUT_MS,
  );

  it.each(INVALID_ENVS)(
    'TASK-036 main.ts no arranca con un env inválido ($label) y no muestra los valores de los secretos',
    async ({ omit, overrides, named }) => {
      const port = await freePort();
      const env = envSource({
        ...overrides,
        PORT: String(port),
        DATABASE_URL: 'postgresql://user:db-password-xyz@localhost:5432/finanzas_test',
      });
      if (omit !== undefined) delete env[omit];

      const main = startMain(env);
      const result = await waitForExit(main.exited);

      const output = main.output();
      expect(result, output).not.toBe('still running');
      expect(result, output).not.toBe(0);
      expect(output).toContain(named);
      expect(output).not.toContain('db-password-xyz');
      for (const value of Object.values(SECRETS)) {
        expect(output).not.toContain(value);
      }
    },
    TEST_TIMEOUT_MS,
  );
});
