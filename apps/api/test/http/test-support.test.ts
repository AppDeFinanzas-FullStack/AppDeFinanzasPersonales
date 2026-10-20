import { randomUUID } from 'node:crypto';

import type { Express } from 'express';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { buildContainer, createApp, type Container } from '../../src/composition/container.js';
import { parseEnv } from '../../src/infrastructure/config/env.js';
import { disconnectTestPrisma, testPrisma } from '../integration/setup/db.js';

/**
 * TASK-060 (plan §1.5, §1.4): the internal test-support routes exist only with
 * `INTEGRATIONS=fake`. `GET /internal/test/mailbox?to=` returns the emails the fake gateway holds
 * and `POST /internal/test/users` creates a confirmed user with the Onboarding finished and
 * returns its credentials (`email` and `password`). With `INTEGRATIONS=real` neither is mounted.
 *
 * TASK-090 (plan §1.5, §1.4): `POST /internal/test/rates` takes `{ bid?, ask?, median?, official?,
 * failure? }` (rates as decimal text, ADR-03; `failure` is a `RateFailure` of the port or `null`),
 * sets the fake rate source the container built and forces `fx.fetchParallel`. It answers 204, and
 * an invalid body gives `VALIDATION_ERROR`. The parallel rows are stored at the Bolivian day
 * (America/La_Paz) of the system clock.
 */
const WEB_ORIGIN = 'http://localhost:5173';
const JOBS_SECRET = 'jobs-secret-value-0123456789abcdef0123456789';
const PASSWORD = 'Clave-segura-123';

const envSource = (integrations: 'fake' | 'real'): Record<string, string> => ({
  NODE_ENV: 'test',
  PORT: '3000',
  DATABASE_URL: process.env['TEST_DATABASE_URL'] ?? '',
  AUTH_SECRET: 'auth-secret-value-0123456789abcdef0123456789',
  HMAC_SECRET: 'hmac-secret-value-0123456789abcdef0123456789',
  JOBS_SECRET,
  RESEND_API_KEY: 're_resend-key-value-0123456789',
  RELEASE: '1.0',
  WEB_ORIGIN,
  INTEGRATIONS: integrations,
});

interface Credentials {
  email?: unknown;
  password?: unknown;
}
interface Problem {
  code?: unknown;
}
interface RateRow {
  kind: string;
  value: string;
}
interface SignInBody {
  me?: { onboarding?: { completed?: unknown }; email?: unknown };
}

let fakeContainer: Container;
let fakeApp: Express;
let realContainer: Container;
let realApp: Express;
const usedEmails = new Set<string>();

beforeAll(async () => {
  fakeContainer = await Promise.resolve(buildContainer(parseEnv(envSource('fake'))));
  fakeApp = await Promise.resolve(createApp(fakeContainer));
  realContainer = await Promise.resolve(buildContainer(parseEnv(envSource('real'))));
  realApp = await Promise.resolve(createApp(realContainer));
});

afterAll(async () => {
  const emails = [...usedEmails];
  const db = testPrisma();
  await db.$executeRaw`DELETE FROM auth_user WHERE email = ANY(${emails}::text[])`;
  await db.$executeRaw`DELETE FROM email_outbox WHERE to_address = ANY(${emails}::text[])`;
  await clearTodayParallelRates();
  await disconnectTestPrisma();
  await fakeContainer.prisma.$disconnect();
  await realContainer.prisma.$disconnect();
});

const freshEmail = (): string => {
  const email = `${randomUUID()}@http-test-support.test`;
  usedEmails.add(email);
  return email;
};

const PARALLEL_KINDS = ['parallel_median', 'parallel_bid', 'parallel_ask'];

/** Today in Bolivia, the day of the parallel rates. */
const boliviaToday = (): string =>
  new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/La_Paz',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());

const clearTodayParallelRates = async (): Promise<void> => {
  const db = testPrisma();
  await db.$executeRaw`
    DELETE FROM market_rate
     WHERE rate_date = ${boliviaToday()}::date
       AND kind::text = ANY(${PARALLEL_KINDS}::text[])`;
  await db.$executeRaw`DELETE FROM job_run WHERE job = 'fx_refresh'`;
};

const todayParallelRates = (): Promise<RateRow[]> =>
  testPrisma().$queryRaw<RateRow[]>`
    SELECT kind::text AS kind, value::text AS value
      FROM market_rate
     WHERE rate_date = ${boliviaToday()}::date
       AND kind::text = ANY(${PARALLEL_KINDS}::text[])
     ORDER BY kind::text`;

const setRates = (app: Express, body: unknown) =>
  request(app).post('/internal/test/rates').set('Origin', WEB_ORIGIN).send(body as object);

const tick = (app: Express) =>
  request(app)
    .post('/internal/jobs/tick')
    .set('Origin', WEB_ORIGIN)
    .set('x-jobs-secret', JOBS_SECRET)
    .send({});

const mailbox = (app: Express, to: string) =>
  request(app).get('/internal/test/mailbox').query({ to }).set('Origin', WEB_ORIGIN);

const createUser = (app: Express) =>
  request(app).post('/internal/test/users').set('Origin', WEB_ORIGIN).send({});

describe('INTEGRATIONS=real', () => {
  it('TASK-060 GET /internal/test/mailbox responde 404', async () => {
    const res = await mailbox(realApp, freshEmail());

    expect(res.status).toBe(404);
  });

  it('TASK-060 POST /internal/test/users responde 404 y no crea ningún usuario', async () => {
    const before = await testPrisma().$queryRaw<{ n: number }[]>`
      SELECT count(*)::int AS n FROM auth_user`;

    const res = await createUser(realApp);

    expect(res.status).toBe(404);
    const after = await testPrisma().$queryRaw<{ n: number }[]>`
      SELECT count(*)::int AS n FROM auth_user`;
    expect(after[0]?.n).toBe(before[0]?.n);
  });
});

describe('INTEGRATIONS=fake', () => {
  it('TASK-060 el buzón devuelve el enlace de confirmación de un registro', async () => {
    const email = freshEmail();
    const signUp = await request(fakeApp)
      .post('/api/auth/sign-up')
      .set('Origin', WEB_ORIGIN)
      .send({ name: 'Ana Pérez', email, password: PASSWORD, acceptTerms: true });
    expect(signUp.status).toBe(202);
    const dispatched = await tick(fakeApp);
    expect(dispatched.status).toBe(204);

    const res = await mailbox(fakeApp, email);

    expect(res.status).toBe(200);
    const text = JSON.stringify(res.body);
    expect(text).toContain(email);
    expect(text).toMatch(/[A-Za-z0-9_-]{43}/);
    expect(text).toContain('confirm');
  });

  it('TASK-060 el buzón no mezcla los correos de otro destinatario', async () => {
    const mine = freshEmail();
    const other = freshEmail();
    for (const email of [mine, other]) {
      const signUp = await request(fakeApp)
        .post('/api/auth/sign-up')
        .set('Origin', WEB_ORIGIN)
        .send({ name: 'Ana Pérez', email, password: PASSWORD, acceptTerms: true });
      expect(signUp.status).toBe(202);
    }
    await tick(fakeApp);

    const res = await mailbox(fakeApp, mine);

    expect(res.status).toBe(200);
    const text = JSON.stringify(res.body);
    expect(text).toContain(mine);
    expect(text).not.toContain(other);
  });

  it('TASK-060 POST /internal/test/users devuelve credenciales de un usuario confirmado que puede entrar', async () => {
    const res = await createUser(fakeApp);

    expect(res.status).toBeGreaterThanOrEqual(200);
    expect(res.status).toBeLessThan(300);
    const credentials = res.body as Credentials;
    expect(typeof credentials.email).toBe('string');
    expect(typeof credentials.password).toBe('string');
    const email = credentials.email as string;
    usedEmails.add(email);

    const signIn = await request(fakeApp)
      .post('/api/auth/sign-in')
      .set('Origin', WEB_ORIGIN)
      .send({ email, password: credentials.password });

    expect(signIn.status).toBe(200);
    const body = signIn.body as SignInBody;
    expect(body.me?.email).toBe(email);
    expect(body.me?.onboarding?.completed).toBe(true);
  });

  it('TASK-060 cada POST /internal/test/users crea un usuario distinto', async () => {
    const first = (await createUser(fakeApp)).body as Credentials;
    const second = (await createUser(fakeApp)).body as Credentials;
    usedEmails.add(first.email as string);
    usedEmails.add(second.email as string);

    expect(first.email).not.toBe(second.email);
  });
});

describe('POST /internal/test/rates', () => {
  beforeEach(async () => {
    await clearTodayParallelRates();
  });

  it('TASK-090 con INTEGRATIONS=real la ruta responde 404 y no escribe tasas', async () => {
    const res = await setRates(realApp, { bid: '10.10', ask: '10.30', median: '10.20' });

    expect(res.status).toBe(404);
    expect(await todayParallelRates()).toEqual([]);
  });

  it('TASK-090 después de fijar 10,10 y 10,30, parallel_bid y parallel_ask del día valen 10,10 y 10,30', async () => {
    const res = await setRates(fakeApp, {
      bid: '10.10',
      ask: '10.30',
      median: '10.20',
      failure: null,
    });

    expect(res.status).toBe(204);
    const rows = await todayParallelRates();
    const valueOf = (kind: string) => rows.find((row) => row.kind === kind)?.value;
    expect(valueOf('parallel_bid')).toBe('10.10');
    expect(valueOf('parallel_ask')).toBe('10.30');
    expect(valueOf('parallel_median')).toBe('10.20');
  });

  it('TASK-090 fijar tasas nuevas el mismo día fuerza la captura y reemplaza las del día', async () => {
    const first = await setRates(fakeApp, {
      bid: '10.10',
      ask: '10.30',
      median: '10.20',
      failure: null,
    });
    expect(first.status).toBe(204);

    const second = await setRates(fakeApp, { bid: '11.10', ask: '11.30', median: '11.20' });

    expect(second.status).toBe(204);
    const rows = await todayParallelRates();
    const valueOf = (kind: string) => rows.find((row) => row.kind === kind)?.value;
    expect(valueOf('parallel_bid')).toBe('11.10');
    expect(valueOf('parallel_ask')).toBe('11.30');
  });

  it('TASK-090 con failure fijado la llamada no escribe filas nuevas', async () => {
    const res = await setRates(fakeApp, {
      bid: '10.10',
      ask: '10.30',
      median: '10.20',
      failure: 'TIMEOUT',
    });

    expect(res.status).toBe(204);
    expect(await todayParallelRates()).toEqual([]);
  });

  it('TASK-090 failure null quita la falla y la siguiente llamada vuelve a escribir', async () => {
    const failing = await setRates(fakeApp, {
      bid: '10.10',
      ask: '10.30',
      median: '10.20',
      failure: 'SOURCE_ERROR',
    });
    expect(failing.status).toBe(204);
    expect(await todayParallelRates()).toEqual([]);

    const res = await setRates(fakeApp, {
      bid: '10.10',
      ask: '10.30',
      median: '10.20',
      failure: null,
    });

    expect(res.status).toBe(204);
    const rows = await todayParallelRates();
    const valueOf = (kind: string) => rows.find((row) => row.kind === kind)?.value;
    expect(valueOf('parallel_bid')).toBe('10.10');
    expect(valueOf('parallel_ask')).toBe('10.30');
  });

  it.each([
    ['una tasa numérica en vez de texto decimal', { bid: 10.1 }],
    ['una tasa que no es decimal', { ask: 'diez' }],
    ['una falla que no existe en el puerto', { failure: 'BROKEN' }],
  ])('TASK-090 un cuerpo inválido (%s) responde VALIDATION_ERROR y no escribe tasas', async (_label, body) => {
    const res = await setRates(fakeApp, body);

    expect(res.status).toBe(400);
    expect((res.body as Problem).code).toBe('VALIDATION_ERROR');
    expect(await todayParallelRates()).toEqual([]);
  });
});
