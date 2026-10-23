import type { Express } from 'express';
import request from 'supertest';
import { uuidv7 } from 'uuidv7';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { buildContainer, createApp, type Container } from '../../src/composition/container.js';
import { parseEnv } from '../../src/infrastructure/config/env.js';
import { createAccount } from '../factories/account.factory.js';
import { createAllocationEvent, createGoal, deleteGoalsOf } from '../factories/goal.factory.js';
import { disconnectTestPrisma, testPrisma } from '../integration/setup/db.js';

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
  free?: string;
}
const problem = (res: { body: unknown }) => res.body as Problem;

interface GoalBody {
  id: string;
  name: string;
  status: string;
  progress: string;
  dedicatedAccount?: { id: string };
}
const goalOf = (res: { body: unknown }) => res.body as GoalBody;

interface Account {
  cookie: string;
  userId: string;
}

const db = testPrisma();
let container: Container;
let app: Express;
const usedEmails: string[] = [];
const usedUsers: string[] = [];
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
  usedUsers.push(userId);
  return { cookie: sessionCookieOf(res), userId };
}

type Method = 'get' | 'post' | 'patch' | 'delete';
const call = (method: Method, path: string, cookie: string | null, body?: object) => {
  const req = request(app)[method](path);
  if (method !== 'get') req.set('Origin', WEB_ORIGIN);
  if (cookie !== null) req.set('Cookie', cookie);
  return method === 'get' || method === 'delete' ? req : req.send(body ?? {});
};

const expectSuccess = (res: { status: number }) => {
  expect(res.status).toBeGreaterThanOrEqual(200);
  expect(res.status).toBeLessThan(300);
};

const newGoalBody = (over: Record<string, unknown> = {}) => ({
  id: uuidv7(),
  name: `Meta ${uuidv7().slice(-8)}`,
  target: '1000.00',
  currencyCode: 'BOB',
  icon: 'piggy-bank',
  color: 'blue',
  ...over,
});

const countGoals = async (userId: string) =>
  Number(
    (
      await db.$queryRaw<{ n: bigint }[]>`
        SELECT count(*) AS n FROM goal WHERE user_id = ${userId}::uuid`
    )[0]?.n ?? 0,
  );

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
  await deleteGoalsOf(usedUsers);
  await db.$executeRaw`DELETE FROM auth_user WHERE email = ANY(${usedEmails}::text[])`;
  await db.$executeRaw`DELETE FROM email_outbox WHERE to_address = ANY(${usedEmails}::text[])`;
  await disconnectTestPrisma();
  await container.prisma.$disconnect();
}, 30_000);

describe('release gate and session', () => {
  it('RF-M2-03 con RELEASE=1.0 las rutas de metas responden 404 RELEASE_NOT_AVAILABLE', async () => {
    const { cookie } = await signedIn();
    process.env['RELEASE'] = '1.0';
    const res = await call('get', '/api/goals', cookie);
    expect(res.status).toBe(404);
    expect(problem(res).code).toBe('RELEASE_NOT_AVAILABLE');
    const post = await call('post', '/api/goals', cookie, newGoalBody());
    expect(post.status).toBe(404);
    expect(problem(post).code).toBe('RELEASE_NOT_AVAILABLE');
  });

  it('TASK-189 sin sesión responde 401', async () => {
    expect((await call('get', '/api/goals', null)).status).toBe(401);
    expect((await call('post', '/api/goals', null, newGoalBody())).status).toBe(401);
  });
});

describe('POST /api/goals', () => {
  it('TASK-189 crea una meta y aparece en GET /api/goals y GET /api/goals/:id', async () => {
    const { cookie } = await signedIn();
    const body = newGoalBody();
    const res = await call('post', '/api/goals', cookie, body);
    expectSuccess(res);
    expect(goalOf(res).id).toBe(body.id);
    const list = await call('get', '/api/goals', cookie);
    expect(list.status).toBe(200);
    expect(JSON.stringify(list.body)).toContain(body.id);
    const one = await call('get', `/api/goals/${body.id}`, cookie);
    expect(one.status).toBe(200);
    expect(goalOf(one).status).toBe('in_progress');
  });

  it('TASK-189 dos POST con el mismo id dejan una fila', async () => {
    const { cookie, userId } = await signedIn();
    const body = newGoalBody();
    expectSuccess(await call('post', '/api/goals', cookie, body));
    expectSuccess(await call('post', '/api/goals', cookie, body));
    expect(await countGoals(userId)).toBe(1);
  });

  it('TASK-189 un cuerpo inválido responde 400 VALIDATION_ERROR', async () => {
    const { cookie } = await signedIn();
    const res = await call('post', '/api/goals', cookie, newGoalBody({ target: 'abc' }));
    expect(res.status).toBe(400);
    expect(problem(res).code).toBe('VALIDATION_ERROR');
  });

  it('TASK-189 con 50 metas la 51 responde 409 LIMIT_REACHED', async () => {
    const { cookie, userId } = await signedIn();
    for (let i = 0; i < 50; i += 1) await createGoal(userId);
    const res = await call('post', '/api/goals', cookie, newGoalBody());
    expect(res.status).toBe(409);
    expect(problem(res).code).toBe('LIMIT_REACHED');
  });

  it('TASK-189 dedicar una tarjeta al crear responde 422 ACCOUNT_NOT_DEDICABLE', async () => {
    const { cookie, userId } = await signedIn();
    const card = await createAccount(userId, { type: 'credit_card' });
    const res = await call(
      'post',
      '/api/goals',
      cookie,
      newGoalBody({ dedicatedAccountId: card.id }),
    );
    expect(res.status).toBe(422);
    expect(problem(res).code).toBe('ACCOUNT_NOT_DEDICABLE');
  });
});

describe('PATCH /api/goals/:id', () => {
  it('TASK-189 edita el nombre de la meta', async () => {
    const { cookie, userId } = await signedIn();
    const goal = await createGoal(userId);
    const res = await call('patch', `/api/goals/${goal.id}`, cookie, { name: 'Nuevo nombre' });
    expectSuccess(res);
    expect(goalOf(res).name).toBe('Nuevo nombre');
  });

  it('TASK-189 una fecha meta pasada responde 422 TARGET_DATE_IN_PAST', async () => {
    const { cookie, userId } = await signedIn();
    const goal = await createGoal(userId);
    const res = await call('patch', `/api/goals/${goal.id}`, cookie, { targetDate: '2000-01-01' });
    expect(res.status).toBe(422);
    expect(problem(res).code).toBe('TARGET_DATE_IN_PAST');
  });

  it('TASK-189 una meta inexistente responde 404', async () => {
    const { cookie } = await signedIn();
    const res = await call('patch', `/api/goals/${uuidv7()}`, cookie, { name: 'X' });
    expect(res.status).toBe(404);
  });
});

describe('earmarks', () => {
  it('TASK-189 aparta dinero y el progreso lo refleja', async () => {
    const { cookie, userId } = await signedIn();
    const goal = await createGoal(userId);
    const acc = await createAccount(userId, { initialBalance: '500.00' });
    const res = await call('post', `/api/goals/${goal.id}/earmarks`, cookie, {
      id: uuidv7(),
      accountId: acc.id,
      amount: '200.00',
    });
    expectSuccess(res);
    expect(goalOf(res).progress).toBe('200.00');
  });

  it('EC-M12-01 apartar más que el saldo libre responde 422 EARMARK_EXCEEDS_FREE con free', async () => {
    const { cookie, userId } = await signedIn();
    const goal = await createGoal(userId);
    const acc = await createAccount(userId, { initialBalance: '100.00' });
    const res = await call('post', `/api/goals/${goal.id}/earmarks`, cookie, {
      id: uuidv7(),
      accountId: acc.id,
      amount: '150.00',
    });
    expect(res.status).toBe(422);
    expect(problem(res).code).toBe('EARMARK_EXCEEDS_FREE');
    expect(problem(res).free).toBe('100.00');
  });

  it('TASK-189 apartar en una tarjeta responde 422 ACCOUNT_NOT_DEDICABLE', async () => {
    const { cookie, userId } = await signedIn();
    const goal = await createGoal(userId);
    const card = await createAccount(userId, { type: 'credit_card' });
    const res = await call('post', `/api/goals/${goal.id}/earmarks`, cookie, {
      id: uuidv7(),
      accountId: card.id,
      amount: '10.00',
    });
    expect(res.status).toBe(422);
    expect(problem(res).code).toBe('ACCOUNT_NOT_DEDICABLE');
  });

  it('TASK-189 libera parte de lo apartado', async () => {
    const { cookie, userId } = await signedIn();
    const goal = await createGoal(userId);
    const acc = await createAccount(userId, { initialBalance: '500.00' });
    await createAllocationEvent(userId, goal.id, acc.id, { amount: '200.00' });
    const res = await call('post', `/api/goals/${goal.id}/earmarks/release`, cookie, {
      accountId: acc.id,
      amount: '50.00',
    });
    expectSuccess(res);
    expect(goalOf(res).progress).toBe('150.00');
  });

  it('TASK-189 liberar más que lo apartado responde 422 RELEASE_EXCEEDS_EARMARK', async () => {
    const { cookie, userId } = await signedIn();
    const goal = await createGoal(userId);
    const acc = await createAccount(userId, { initialBalance: '500.00' });
    await createAllocationEvent(userId, goal.id, acc.id, { amount: '20.00' });
    const res = await call('post', `/api/goals/${goal.id}/earmarks/release`, cookie, {
      accountId: acc.id,
      amount: '50.00',
    });
    expect(res.status).toBe(422);
    expect(problem(res).code).toBe('RELEASE_EXCEEDS_EARMARK');
  });
});

describe('dedicate', () => {
  it('TASK-189 dedica una cuenta a la meta', async () => {
    const { cookie, userId } = await signedIn();
    const goal = await createGoal(userId);
    const acc = await createAccount(userId, { initialBalance: '300.00' });
    const res = await call('post', `/api/goals/${goal.id}/dedicate`, cookie, {
      accountId: acc.id,
    });
    expectSuccess(res);
    expect(goalOf(res).dedicatedAccount?.id).toBe(acc.id);
  });

  it('EC-M12-06 una cuenta con apartados de otras metas responde 409 ACCOUNT_HAS_OTHER_EARMARKS', async () => {
    const { cookie, userId } = await signedIn();
    const other = await createGoal(userId);
    const goal = await createGoal(userId);
    const acc = await createAccount(userId, { initialBalance: '300.00' });
    await createAllocationEvent(userId, other.id, acc.id, { amount: '50.00' });
    const res = await call('post', `/api/goals/${goal.id}/dedicate`, cookie, {
      accountId: acc.id,
    });
    expect(res.status).toBe(409);
    expect(problem(res).code).toBe('ACCOUNT_HAS_OTHER_EARMARKS');
  });

  it('TASK-189 una cuenta ya dedicada a otra meta responde 409 ACCOUNT_ALREADY_DEDICATED', async () => {
    const { cookie, userId } = await signedIn();
    const acc = await createAccount(userId, { initialBalance: '300.00' });
    await createGoal(userId, { dedicatedAccountId: acc.id });
    const goal = await createGoal(userId);
    const res = await call('post', `/api/goals/${goal.id}/dedicate`, cookie, {
      accountId: acc.id,
    });
    expect(res.status).toBe(409);
    expect(problem(res).code).toBe('ACCOUNT_ALREADY_DEDICATED');
  });

  it('TASK-189 dedicar una tarjeta responde 422 ACCOUNT_NOT_DEDICABLE', async () => {
    const { cookie, userId } = await signedIn();
    const goal = await createGoal(userId);
    const card = await createAccount(userId, { type: 'credit_card' });
    const res = await call('post', `/api/goals/${goal.id}/dedicate`, cookie, {
      accountId: card.id,
    });
    expect(res.status).toBe(422);
    expect(problem(res).code).toBe('ACCOUNT_NOT_DEDICABLE');
  });
});

describe('use-and-close, archive, restore, delete, celebrated', () => {
  it('TASK-189 usar y cerrar archiva la meta y deja los apartados en 0', async () => {
    const { cookie, userId } = await signedIn();
    const goal = await createGoal(userId);
    const acc = await createAccount(userId, { initialBalance: '500.00' });
    await createAllocationEvent(userId, goal.id, acc.id, { amount: '200.00' });
    const res = await call('post', `/api/goals/${goal.id}/use-and-close`, cookie);
    expectSuccess(res);
    const rows = await db.$queryRaw<{ archived: boolean; sum: string }[]>`
      SELECT (g.archived_at IS NOT NULL) AS archived,
             COALESCE((SELECT sum(amount) FROM goal_allocation_event WHERE goal_id = g.id), 0)::text AS sum
        FROM goal g WHERE g.id = ${goal.id}::uuid`;
    expect(rows[0]?.archived).toBe(true);
    expect(Number(rows[0]?.sum)).toBe(0);
  });

  it('TASK-189 archiva una meta vacía y la restaura', async () => {
    const { cookie, userId } = await signedIn();
    const goal = await createGoal(userId);
    expectSuccess(await call('post', `/api/goals/${goal.id}/archive`, cookie));
    const archived = await call('get', `/api/goals/${goal.id}`, cookie);
    expect(goalOf(archived).status).toBe('archived');
    expectSuccess(await call('post', `/api/goals/${goal.id}/restore`, cookie));
    const restored = await call('get', `/api/goals/${goal.id}`, cookie);
    expect(goalOf(restored).status).not.toBe('archived');
  });

  it('TASK-189 archivar una meta con apartados responde 409 GOAL_NOT_EMPTY', async () => {
    const { cookie, userId } = await signedIn();
    const goal = await createGoal(userId);
    const acc = await createAccount(userId, { initialBalance: '500.00' });
    await createAllocationEvent(userId, goal.id, acc.id, { amount: '20.00' });
    const res = await call('post', `/api/goals/${goal.id}/archive`, cookie);
    expect(res.status).toBe(409);
    expect(problem(res).code).toBe('GOAL_NOT_EMPTY');
  });

  it('TASK-189 elimina una meta vacía', async () => {
    const { cookie, userId } = await signedIn();
    const goal = await createGoal(userId);
    expectSuccess(await call('delete', `/api/goals/${goal.id}`, cookie));
    expect(await countGoals(userId)).toBe(0);
    expect((await call('get', `/api/goals/${goal.id}`, cookie)).status).toBe(404);
  });

  it('TASK-189 eliminar una meta con apartados responde 409 GOAL_NOT_EMPTY', async () => {
    const { cookie, userId } = await signedIn();
    const goal = await createGoal(userId);
    const acc = await createAccount(userId, { initialBalance: '500.00' });
    await createAllocationEvent(userId, goal.id, acc.id, { amount: '20.00' });
    const res = await call('delete', `/api/goals/${goal.id}`, cookie);
    expect(res.status).toBe(409);
    expect(problem(res).code).toBe('GOAL_NOT_EMPTY');
  });

  it('TASK-189 celebrated marca celebrated_at', async () => {
    const { cookie, userId } = await signedIn();
    const goal = await createGoal(userId);
    expectSuccess(await call('post', `/api/goals/${goal.id}/celebrated`, cookie));
    const rows = await db.$queryRaw<{ done: boolean }[]>`
      SELECT (celebrated_at IS NOT NULL) AS done FROM goal WHERE id = ${goal.id}::uuid`;
    expect(rows[0]?.done).toBe(true);
  });

  it('TASK-189 GET de una meta inexistente responde 404', async () => {
    const { cookie } = await signedIn();
    expect((await call('get', `/api/goals/${uuidv7()}`, cookie)).status).toBe(404);
  });
});
