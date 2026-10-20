import { randomUUID } from 'node:crypto';

import type { Express } from 'express';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { buildContainer, createApp, type Container } from '../../src/composition/container.js';
import { parseEnv } from '../../src/infrastructure/config/env.js';
import { disconnectTestPrisma, testPrisma } from '../integration/setup/db.js';

/**
 * TASK-060 (plan §1.5, §1.4): the internal test-support routes exist only with
 * `INTEGRATIONS=fake`. `GET /internal/test/mailbox?to=` returns the emails the fake gateway holds
 * and `POST /internal/test/users` creates a confirmed user with the Onboarding finished and
 * returns its credentials (`email` and `password`). With `INTEGRATIONS=real` neither is mounted.
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
  await disconnectTestPrisma();
  await fakeContainer.prisma.$disconnect();
  await realContainer.prisma.$disconnect();
});

const freshEmail = (): string => {
  const email = `${randomUUID()}@http-test-support.test`;
  usedEmails.add(email);
  return email;
};

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
