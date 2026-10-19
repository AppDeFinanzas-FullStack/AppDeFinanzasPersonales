import express from 'express';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { errorHandler } from '../../src/presentation/middlewares/error-handler.js';
import { releaseGate } from '../../src/presentation/middlewares/release-gate.js';

interface Problem {
  code?: string;
  status?: number;
  traceId?: string;
  stack?: unknown;
}
const problem = (res: { body: unknown }) => res.body as Problem;

const original = process.env['RELEASE'];

beforeEach(() => {
  delete process.env['RELEASE'];
});

afterEach(() => {
  if (original === undefined) delete process.env['RELEASE'];
  else process.env['RELEASE'] = original;
});

// RELEASE is set before the gate is created and stays set while requests run.
const buildApp = (release: string, module: 'M11' | 'M3' | 'M14') => {
  process.env['RELEASE'] = release;
  const app = express();
  app.use(express.json());
  app.get('/gated', releaseGate(module), (_req, res) => res.status(200).json({ ok: true }));
  app.use(errorHandler);
  return app;
};

describe('releaseGate', () => {
  it('RF-M2-03 con RELEASE=1.0 una ruta de M11 responde 404 RELEASE_NOT_AVAILABLE', async () => {
    const res = await request(buildApp('1.0', 'M11')).get('/gated');
    expect(res.status).toBe(404);
    expect(res.headers['content-type']).toMatch(/application\/problem\+json/);
    expect(problem(res).code).toBe('RELEASE_NOT_AVAILABLE');
    expect(problem(res).status).toBe(404);
    expect(typeof problem(res).traceId).toBe('string');
    expect(problem(res).stack).toBeUndefined();
  });

  it('RF-M2-03 con RELEASE=1.1 una ruta de M11 pasa', async () => {
    const res = await request(buildApp('1.1', 'M11')).get('/gated');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
  });

  it('RF-M2-03 con RELEASE=1.2 una ruta de M11 pasa', async () => {
    const res = await request(buildApp('1.2', 'M11')).get('/gated');
    expect(res.status).toBe(200);
  });

  it('RF-M2-03 con RELEASE=1.0 una ruta de M3 (módulo de la 1.0) pasa', async () => {
    const res = await request(buildApp('1.0', 'M3')).get('/gated');
    expect(res.status).toBe(200);
  });

  it('RF-M2-03 con RELEASE=1.1 una ruta de M14 responde 404 RELEASE_NOT_AVAILABLE', async () => {
    const res = await request(buildApp('1.1', 'M14')).get('/gated');
    expect(res.status).toBe(404);
    expect(problem(res).code).toBe('RELEASE_NOT_AVAILABLE');
  });

  it('RF-M2-03 con RELEASE=1.2 una ruta de M14 pasa', async () => {
    const res = await request(buildApp('1.2', 'M14')).get('/gated');
    expect(res.status).toBe(200);
  });

  it('RF-M2-03 el handler de la ruta no se ejecuta cuando el módulo no está liberado', async () => {
    process.env['RELEASE'] = '1.0';
    let reached = false;
    const app = express();
    app.get('/gated', releaseGate('M11'), (_req, res) => {
      reached = true;
      res.status(200).end();
    });
    app.use(errorHandler);
    await request(app).get('/gated');
    expect(reached).toBe(false);
  });
});
