import type { Express, RequestHandler } from 'express';
import express from 'express';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { buildContainer, createApp, type Container } from '../../src/composition/container.js';
import { parseEnv } from '../../src/infrastructure/config/env.js';
import { errorHandler } from '../../src/presentation/middlewares/error-handler.js';
import { serverTiming } from '../../src/presentation/middlewares/server-timing.js';

/**
 * `Server-Timing` of every response and `queries`/`durationMs` of the request log (plan §4.0,
 * "Costo de una petición"; RNF-29, RNF-17). The real app runs over the test database with fake
 * integrations; the 7-operation case drives the `serverTiming` middleware with a simulated counter
 * that follows the `QueryCounter` port: `begin()`, `record(ms)` and `read()` returning
 * `{ queries, dbMs }`.
 */
const WEB_ORIGIN = 'http://localhost:5173';

const envSource = (extra: Record<string, string> = {}): Record<string, string> => ({
  NODE_ENV: 'test',
  PORT: '3000',
  DATABASE_URL: process.env['TEST_DATABASE_URL'] ?? '',
  AUTH_SECRET: 'auth-secret-value-0123456789abcdef0123456789',
  HMAC_SECRET: 'hmac-secret-value-0123456789abcdef0123456789',
  JOBS_SECRET: 'jobs-secret-value-0123456789abcdef0123456789',
  RESEND_API_KEY: 're_resend-key-value-0123456789',
  RELEASE: '1.0',
  WEB_ORIGIN,
  INTEGRATIONS: 'fake',
  ...extra,
});

/** `total;dur=12.3, db;dur=4.5, queries;desc="3"`: only numbers, nothing internal. */
const HEADER_FORMAT = /^total;dur=(\d+(?:\.\d+)?), db;dur=(\d+(?:\.\d+)?), queries;desc="(\d+)"$/;

interface Timing {
  total: number;
  db: number;
  queries: number;
}

const timingOf = (res: { headers: Record<string, unknown> }): Timing => {
  const header = res.headers['server-timing'];
  expect(typeof header).toBe('string');
  const match = HEADER_FORMAT.exec(header as string);
  expect(match, `Server-Timing malformado: ${String(header)}`).not.toBeNull();
  return {
    total: Number(match?.[1]),
    db: Number(match?.[2]),
    queries: Number(match?.[3]),
  };
};

const captureLines = () => {
  const lines: string[] = [];
  vi.spyOn(console, 'info').mockImplementation((...args: unknown[]) => {
    lines.push(args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' '));
  });
  return lines;
};

let container: Container;
let app: Express;
let slowContainer: Container;
let slowApp: Express;

beforeAll(() => {
  container = buildContainer(parseEnv(envSource()));
  app = createApp(container);
  slowContainer = buildContainer(parseEnv(envSource({ DB_LATENCY_MS: '25' })));
  slowApp = createApp(slowContainer);
});

afterAll(async () => {
  await container.prisma.$disconnect();
  await slowContainer.prisma.$disconnect();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('Server-Timing en toda respuesta', () => {
  it('RNF-29 una respuesta correcta sin base de datos lleva total, db y queries', async () => {
    const res = await request(app).get('/api/health');
    expect(res.status).toBe(204);
    const timing = timingOf(res);
    expect(timing.queries).toBe(0);
    expect(timing.db).toBe(0);
    expect(timing.total).toBeGreaterThanOrEqual(0);
  });

  it('RNF-29 una respuesta que consulta la base cuenta sus operaciones y su tiempo', async () => {
    const res = await request(app).get('/api/health/ready');
    expect(res.status).toBe(204);
    const timing = timingOf(res);
    expect(timing.queries).toBeGreaterThanOrEqual(1);
    expect(timing.db).toBeGreaterThan(0);
    expect(timing.total).toBeGreaterThanOrEqual(timing.db);
  });

  it('RNF-29 una ruta inexistente (404) también lleva Server-Timing', async () => {
    const res = await request(app).get('/api/no-existe');
    expect(res.status).toBe(404);
    timingOf(res);
  });

  it('RNF-29 un 401 sin sesión también lleva Server-Timing', async () => {
    const res = await request(app).get('/api/me');
    expect(res.status).toBe(401);
    timingOf(res);
  });

  it('RNF-29 un 415 también lleva Server-Timing', async () => {
    const res = await request(app)
      .post('/api/health')
      .set('Origin', WEB_ORIGIN)
      .set('Content-Type', 'text/plain')
      .send('hola');
    expect(res.status).toBe(415);
    timingOf(res);
  });

  it('RNF-29 un 403 por Origin ajeno también lleva Server-Timing', async () => {
    const res = await request(app)
      .post('/api/health')
      .set('Origin', 'https://evil.example.com')
      .set('Content-Type', 'application/json')
      .send({});
    expect(res.status).toBe(403);
    timingOf(res);
  });

  it('RNF-29 un 400 por JSON mal formado también lleva Server-Timing', async () => {
    const res = await request(app)
      .post('/api/health')
      .set('Origin', WEB_ORIGIN)
      .set('Content-Type', 'application/json')
      .send('{"a": ');
    expect(res.status).toBe(400);
    timingOf(res);
  });

  it('RNF-29 un error inesperado (500) también lleva Server-Timing', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const counter = simulatedCounter();
    const failing = express();
    failing.use(serverTiming(counter));
    failing.get('/boom', () => {
      throw new Error('fallo interno');
    });
    failing.use(errorHandler);
    const res = await request(failing).get('/boom');
    expect(res.status).toBe(500);
    timingOf(res);
  });
});

/** Simulated `QueryCounter`: keeps what `record` receives between `begin` and `read`. */
function simulatedCounter() {
  let recorded: number[] = [];
  return {
    begin: vi.fn(() => {
      recorded = [];
    }),
    record: (ms: number) => {
      recorded.push(ms);
    },
    read: () => ({
      queries: recorded.length,
      dbMs: recorded.reduce((sum, ms) => sum + ms, 0),
    }),
  };
}

describe('Server-Timing con un contador simulado', () => {
  it('RNF-29 con 7 operaciones registradas, queries vale 7 y db suma sus duraciones', async () => {
    const counter = simulatedCounter();
    const durations = [1, 2, 3, 4, 5, 6, 7];
    const handler: RequestHandler = (_req, res) => {
      for (const ms of durations) counter.record(ms);
      setTimeout(() => res.status(200).json({ ok: true }), 40);
    };
    const simulated = express();
    simulated.use(serverTiming(counter));
    simulated.get('/work', handler);

    const res = await request(simulated).get('/work');
    expect(res.status).toBe(200);
    const timing = timingOf(res);
    expect(timing.queries).toBe(7);
    expect(timing.db).toBeCloseTo(28, 1);
    expect(timing.total).toBeGreaterThanOrEqual(35);
    expect(counter.begin).toHaveBeenCalledTimes(1);
  });

  it('RNF-29 sin operaciones registradas, queries vale 0 y db vale 0', async () => {
    const simulated = express();
    simulated.use(serverTiming(simulatedCounter()));
    simulated.get('/idle', (_req, res) => {
      res.status(204).end();
    });
    const res = await request(simulated).get('/idle');
    const timing = timingOf(res);
    expect(timing.queries).toBe(0);
    expect(timing.db).toBe(0);
  });
});

describe('peticiones simultáneas', () => {
  it('RNF-29 dos peticiones simultáneas no mezclan sus conteos', async () => {
    const solo = timingOf(await request(slowApp).get('/api/health/ready')).queries;
    expect(solo).toBeGreaterThanOrEqual(1);

    const batch = await Promise.all(
      Array.from({ length: 12 }, (_, i) =>
        i % 2 === 0
          ? request(slowApp).get('/api/health/ready')
          : request(slowApp).get('/api/health'),
      ),
    );
    batch.forEach((res, i) => {
      const { queries } = timingOf(res);
      expect(queries, `petición ${i}`).toBe(i % 2 === 0 ? solo : 0);
    });
  });
});

describe('sin detalles internos', () => {
  const FORBIDDEN =
    /select|insert|update|delete|from|where|pg_|prisma|postgres|user|session|account|\/|\\|\.ts|\.js/i;

  it('RNF-17 la cabecera no contiene SQL, nombres de tablas ni rutas internas', async () => {
    const responses = [
      await request(app).get('/api/health/ready'),
      await request(app).get('/api/me'),
      await request(app).get('/api/no-existe'),
    ];
    for (const res of responses) {
      const header = res.headers['server-timing'] as string;
      expect(header).toMatch(HEADER_FORMAT);
      expect(header).not.toMatch(FORBIDDEN);
    }
  });

  it('RNF-17 requestLog agrega durationMs y queries, sin parámetros ni cuerpo', async () => {
    const lines = captureLines();
    const res = await request(app)
      .get('/api/health/ready?token=tok_abcdef123456&email=a@b.com')
      .set('Origin', WEB_ORIGIN);
    const { queries } = timingOf(res);

    const line = lines.find((l) => l.includes('/api/health/ready'));
    expect(line).toBeDefined();
    const entry = JSON.parse(line ?? '{}') as Record<string, unknown>;
    expect(entry['path']).toBe('/api/health/ready');
    expect(entry['status']).toBe(204);
    expect(typeof entry['durationMs']).toBe('number');
    expect(entry['queries']).toBe(queries);
    expect(queries).toBeGreaterThanOrEqual(1);

    expect(line).not.toContain('tok_abcdef123456');
    expect(line).not.toContain('a@b.com');
    expect(line).not.toMatch(/select|insert|update/i);
  });

  it('RNF-17 el log de una petición sin consultas registra queries 0', async () => {
    const lines = captureLines();
    await request(app).get('/api/health');
    const line = lines.find((l) => l.includes('/api/health'));
    const entry = JSON.parse(line ?? '{}') as Record<string, unknown>;
    expect(entry['queries']).toBe(0);
    expect(typeof entry['durationMs']).toBe('number');
  });
});

describe('latencia simulada de la base', () => {
  it('RNF-29 con DB_LATENCY_MS=25, una petición de 4 operaciones tarda al menos 100 ms en la base', async () => {
    const run = async (client: Container['prisma']) => {
      const start = performance.now();
      for (let i = 0; i < 4; i += 1) {
        await client.$queryRaw`SELECT 1`;
      }
      return performance.now() - start;
    };
    await run(slowContainer.prisma); // opens the connection before measuring

    const delayed = await run(slowContainer.prisma);
    const plain = await run(container.prisma);

    // 4 x 25 ms = 100 ms; timers may fire a millisecond early.
    expect(delayed).toBeGreaterThanOrEqual(97);
    expect(plain).toBeLessThan(delayed);
  });

  it('RNF-29 con DB_LATENCY_MS=25, db en Server-Timing refleja el retraso de cada operación', async () => {
    const res = await request(slowApp).get('/api/health/ready');
    const timing = timingOf(res);
    expect(timing.queries).toBeGreaterThanOrEqual(1);
    expect(timing.db).toBeGreaterThanOrEqual(24 * timing.queries);
    expect(timing.total).toBeGreaterThanOrEqual(timing.db);
  });
});
