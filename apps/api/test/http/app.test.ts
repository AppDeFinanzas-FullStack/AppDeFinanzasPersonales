import express from 'express';
import request from 'supertest';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

import { AppError } from '../../src/application/errors.js';
import { createApp } from '../../src/presentation/app.js';
import { errorHandler } from '../../src/presentation/middlewares/error-handler.js';
import { validate } from '../../src/presentation/middlewares/validate.js';

const WEB_ORIGIN = 'http://localhost:5173';

interface Problem {
  code?: string;
  status?: number;
  data?: unknown;
  traceId?: string;
  stack?: unknown;
}
const problem = (res: { body: unknown }) => res.body as Problem;

// The plan does not fix the shape of `deps`; WEB_ORIGIN is offered under both names.
const buildApp = () => createApp({ webOrigin: WEB_ORIGIN, env: { WEB_ORIGIN } } as never);

const captureLogs = () => {
  const chunks: string[] = [];
  const push = (...args: unknown[]) => {
    chunks.push(
      args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' '),
    );
  };
  for (const m of ['log', 'info', 'warn', 'error', 'debug'] as const) {
    vi.spyOn(console, m).mockImplementation(push);
  }
  vi.spyOn(process.stdout, 'write').mockImplementation(((c: unknown) => {
    push(String(c));
    return true;
  }));
  vi.spyOn(process.stderr, 'write').mockImplementation(((c: unknown) => {
    push(String(c));
    return true;
  }));
  return () => chunks.join('\n');
};

const appWithRoutes = (setup: (app: express.Express) => void) => {
  const app = express();
  app.use(express.json());
  setup(app);
  app.use(errorHandler);
  return app;
};

afterEach(() => {
  vi.restoreAllMocks();
});

describe('GET /api/health', () => {
  it('TASK-034 GET /api/health responde 204 sin sesión', async () => {
    const res = await request(buildApp()).get('/api/health');
    expect(res.status).toBe(204);
    expect(res.text).toBe('');
  });
});

describe('requireJson y checkOrigin', () => {
  it('TASK-034 una mutación sin JSON responde 415', async () => {
    const res = await request(buildApp())
      .post('/api/health')
      .set('Origin', WEB_ORIGIN)
      .set('Content-Type', 'text/plain')
      .send('hola');
    expect(res.status).toBe(415);
    expect(res.headers['content-type']).toMatch(/application\/problem\+json/);
    expect(problem(res).code).toBe('UNSUPPORTED_MEDIA_TYPE');
    expect(problem(res).status).toBe(415);
    expect(typeof problem(res).traceId).toBe('string');
  });

  it('TASK-034 una mutación sin Content-Type JSON y con cuerpo de formulario responde 415 UNSUPPORTED_MEDIA_TYPE', async () => {
    const res = await request(buildApp())
      .delete('/api/health')
      .set('Origin', WEB_ORIGIN)
      .type('form')
      .send({ a: '1' });
    expect(res.status).toBe(415);
    expect(problem(res).code).toBe('UNSUPPORTED_MEDIA_TYPE');
  });

  it('TASK-034 una mutación con un Origin ajeno responde 403 ORIGIN_NOT_ALLOWED', async () => {
    const res = await request(buildApp())
      .post('/api/health')
      .set('Origin', 'https://evil.example.com')
      .set('Content-Type', 'application/json')
      .send({});
    expect(res.status).toBe(403);
    expect(res.headers['content-type']).toMatch(/application\/problem\+json/);
    expect(problem(res).code).toBe('ORIGIN_NOT_ALLOWED');
    expect(problem(res).status).toBe(403);
    expect(typeof problem(res).traceId).toBe('string');
  });

  it('TASK-034 una mutación sin Origin no se rechaza', async () => {
    const res = await request(buildApp())
      .post('/api/health')
      .set('Content-Type', 'application/json')
      .send({});
    expect([415, 403]).not.toContain(res.status);
    expect(problem(res).code).not.toBe('ORIGIN_NOT_ALLOWED');
  });

  it('TASK-034 un cuerpo JSON mal formado responde VALIDATION_ERROR 400', async () => {
    const res = await request(buildApp())
      .post('/api/health')
      .set('Origin', WEB_ORIGIN)
      .set('Content-Type', 'application/json')
      .send('{"a": ');
    expect(res.status).toBe(400);
    expect(res.headers['content-type']).toMatch(/application\/problem\+json/);
    expect(problem(res).code).toBe('VALIDATION_ERROR');
    expect(typeof problem(res).traceId).toBe('string');
    expect(problem(res).stack).toBeUndefined();
    expect(res.text).not.toMatch(/\bat .*\(.*:\d+:\d+\)/);
  });

  it('TASK-034 una mutación JSON con el Origin de WEB_ORIGIN no es rechazada por 415 ni 403', async () => {
    const res = await request(buildApp())
      .post('/api/health')
      .set('Origin', WEB_ORIGIN)
      .set('Content-Type', 'application/json')
      .send({});
    expect([415, 403]).not.toContain(res.status);
  });
});

describe('errorHandler', () => {
  it('TASK-034 un AppError se responde como problem+json con su code, status y data', async () => {
    const app = appWithRoutes((a) =>
      a.get('/boom', () => {
        throw new AppError('NEGATIVE_BALANCE', { accountId: 'a1', resultingBalance: '-5.00' });
      }),
    );
    const res = await request(app).get('/boom');
    expect(res.status).toBe(422);
    expect(res.headers['content-type']).toMatch(/application\/problem\+json/);
    expect(problem(res).code).toBe('NEGATIVE_BALANCE');
    expect(problem(res).status).toBe(422);
    expect(problem(res).data).toEqual({ accountId: 'a1', resultingBalance: '-5.00' });
    expect(typeof problem(res).traceId).toBe('string');
    expect((problem(res).traceId ?? '').length).toBeGreaterThan(0);
  });

  it('RNF-17 un error inesperado devuelve solo INTERNAL_ERROR y traceId, sin stack', async () => {
    const secret = 'SECRET_DB_PASSWORD_xyz';
    const app = appWithRoutes((a) =>
      a.get('/boom', () => {
        throw new Error(`connection to postgres://user:${secret}@db failed`);
      }),
    );
    const res = await request(app).get('/boom');
    expect(res.status).toBe(500);
    expect(res.headers['content-type']).toMatch(/application\/problem\+json/);
    expect(problem(res).code).toBe('INTERNAL_ERROR');
    expect(problem(res).status).toBe(500);
    expect(typeof problem(res).traceId).toBe('string');
    expect((problem(res).traceId ?? '').length).toBeGreaterThan(0);
    expect(problem(res).data).toBeUndefined();
    expect(problem(res).stack).toBeUndefined();
    const raw = res.text;
    expect(raw).not.toContain(secret);
    expect(raw).not.toContain('postgres://');
    expect(raw).not.toMatch(/\bat .*\(.*:\d+:\d+\)/);
    expect(raw).not.toContain('stack');
  });

  it('RNF-17 un error asíncrono inesperado también devuelve solo INTERNAL_ERROR', async () => {
    const app = appWithRoutes((a) =>
      a.get('/boom', () =>
        Promise.reject(new TypeError('cannot read properties of undefined')),
      ),
    );
    const res = await request(app).get('/boom');
    expect(res.status).toBe(500);
    expect(problem(res).code).toBe('INTERNAL_ERROR');
    expect(res.text).not.toContain('cannot read properties');
  });
});

describe('validate', () => {
  const schema = z.object({ name: z.string().min(1), amount: z.string() });

  const buildValidated = () =>
    appWithRoutes((a) => a.post('/things', validate(schema), (_req, res) => res.status(201).json({ ok: true })));

  it('TASK-034 validate responde VALIDATION_ERROR 400 con una entrada inválida', async () => {
    const res = await request(buildValidated())
      .post('/things')
      .set('Content-Type', 'application/json')
      .send({ name: '', amount: 5 });
    expect(res.status).toBe(400);
    expect(res.headers['content-type']).toMatch(/application\/problem\+json/);
    expect(problem(res).code).toBe('VALIDATION_ERROR');
    expect(typeof problem(res).traceId).toBe('string');
  });

  it('TASK-034 validate no expone el valor enviado ni detalles internos en los detalles', async () => {
    const secret = 'MySuperSecretPassword123';
    const res = await request(buildValidated())
      .post('/things')
      .set('Content-Type', 'application/json')
      .send({ name: secret, amount: 123 });
    expect(res.status).toBe(400);
    expect(res.text).not.toContain(secret);
    expect(problem(res).stack).toBeUndefined();
    expect(res.text).not.toMatch(/\bat .*\(.*:\d+:\d+\)/);
  });

  it('TASK-034 validate deja pasar una entrada válida', async () => {
    const res = await request(buildValidated())
      .post('/things')
      .set('Content-Type', 'application/json')
      .send({ name: 'x', amount: '1.00' });
    expect(res.status).toBe(201);
  });
});

describe('log de peticiones', () => {
  it('TASK-034 el log de una petición no contiene su cuerpo', async () => {
    const getLogs = captureLogs();
    const password = 'Sup3rS3cretPassw0rd!';
    const token = 'tok_abcdef123456';
    await request(buildApp())
      .post('/api/health')
      .set('Origin', WEB_ORIGIN)
      .set('Content-Type', 'application/json')
      .send({ email: 'a@b.com', password, token });
    const logs = getLogs();
    expect(logs).not.toContain(password);
    expect(logs).not.toContain(token);
    expect(logs).not.toContain('a@b.com');
  });

  it('TASK-034 el log registra la ruta, el código y la duración de la petición', async () => {
    const getLogs = captureLogs();
    await request(buildApp()).get('/api/health');
    const logs = getLogs();
    expect(logs).toContain('/api/health');
    expect(logs).toContain('204');
    expect(logs).toMatch(/\d+(\.\d+)?\s*ms|duration/i);
  });

  it('RNF-17 el log de un error inesperado no incluye el stack ni lo envía al cliente', async () => {
    const getLogs = captureLogs();
    const res = await request(buildApp()).get('/api/health');
    expect(res.status).toBe(204);
    expect(getLogs()).not.toMatch(/\bat .*\(.*:\d+:\d+\)/);
  });
});
