import type { DebtDto, DebtsSummaryDto } from '@finanzas/contracts';
import type { Express } from 'express';
import request from 'supertest';
import { uuidv7 } from 'uuidv7';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { buildContainer, createApp, type Container } from '../../src/composition/container.js';
import { parseEnv } from '../../src/infrastructure/config/env.js';
import { createAccount } from '../factories/account.factory.js';
import {
  createDebt,
  createDebtPayment,
  findStoredDebt,
  storedPaymentIdsOf,
} from '../factories/debt.factory.js';
import { createAllocationEvent, createGoal, deleteGoalsOf } from '../factories/goal.factory.js';
import { createLedgerTransaction, deleteLedgerOf } from '../factories/ledger.factory.js';
import { countTransactionsOf, findStoredTransaction } from '../factories/transaction.factory.js';
import { disconnectTestPrisma, testPrisma } from '../integration/setup/db.js';

/**
 * The HTTP surface of plan §4.13.2 behind `releaseGate` (ADR-18). The bodies follow the contracts
 * of plan §4.13.1: a debt answers with its `DebtDto` and the list with `{ debts, summary }`.
 * Every date is in the past of the real clock, because the server runs with the real time.
 * Only BOB accounts are used, so no market rate is needed.
 */

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
  pending?: string;
  reason?: string;
  count?: number;
}
const problem = (res: { body: unknown }) => res.body as Problem;
const debtOf = (res: { body: unknown }) => res.body as DebtDto;

interface DebtsList {
  debts: DebtDto[];
  summary: DebtsSummaryDto;
}
const listOf = (res: { body: unknown }) => res.body as DebtsList;

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

const START = '2025-01-01';
const PAY_DATE = '2025-06-01';
const ACCOUNT_SINCE = '2024-01-01';

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
  if (method === 'get') return req;
  if (method === 'delete') return body === undefined ? req : req.send(body);
  return req.send(body ?? {});
};

const expectSuccess = (res: { status: number }) => {
  expect(res.status).toBeGreaterThanOrEqual(200);
  expect(res.status).toBeLessThan(300);
};

const newDebtBody = (over: Record<string, unknown> = {}) => ({
  id: uuidv7(),
  direction: 'i_owe',
  person: 'Juan',
  principal: '1000.00',
  currencyCode: 'BOB',
  startDate: START,
  ...over,
});

const paymentBody = (over: Record<string, unknown> = {}) => ({
  id: uuidv7(),
  amount: '100.00',
  interestPart: '0.00',
  capitalPart: '100.00',
  date: PAY_DATE,
  ...over,
});

const accountPart = (accountId: string) => ({
  accountId,
  capitalTransactionId: uuidv7(),
  interestTransactionId: uuidv7(),
});

const countDebts = async (userId: string) =>
  Number(
    (
      await db.$queryRaw<{ n: bigint }[]>`
        SELECT count(*) AS n FROM debt WHERE user_id = ${userId}::uuid`
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
  if (usedUsers.length > 0) {
    await db.$executeRaw`DELETE FROM debt WHERE user_id = ANY(${usedUsers}::uuid[])`;
  }
  await deleteGoalsOf(usedUsers);
  await deleteLedgerOf(usedUsers);
  await db.$executeRaw`DELETE FROM auth_user WHERE email = ANY(${usedEmails}::text[])`;
  await db.$executeRaw`DELETE FROM email_outbox WHERE to_address = ANY(${usedEmails}::text[])`;
  await disconnectTestPrisma();
  await container.prisma.$disconnect();
}, 60_000);

describe('release gate and session', () => {
  it('RF-M2-03 con RELEASE=1.0 las rutas de deudas responden 404 RELEASE_NOT_AVAILABLE', async () => {
    const { cookie, userId } = await signedIn();
    const debt = await createDebt(userId, { startDate: START });
    process.env['RELEASE'] = '1.0';
    const attempts: [string, Method, string, object | undefined][] = [
      ['GET', 'get', '/api/debts', undefined],
      ['POST', 'post', '/api/debts', newDebtBody()],
      ['PATCH', 'patch', `/api/debts/${debt.id}`, { note: 'x' }],
      ['payments', 'post', `/api/debts/${debt.id}/payments`, paymentBody()],
      ['payments/last', 'delete', `/api/debts/${debt.id}/payments/last`, undefined],
      ['forgive', 'post', `/api/debts/${debt.id}/forgive`, undefined],
      ['DELETE', 'delete', `/api/debts/${debt.id}`, undefined],
    ];
    for (const [label, method, path, body] of attempts) {
      const res = await call(method, path, cookie, body);
      expect(res.status, label).toBe(404);
      expect(problem(res).code, label).toBe('RELEASE_NOT_AVAILABLE');
    }
    const stored = await findStoredDebt(debt.id);
    expect(stored?.status).toBe('active');
    expect(await countDebts(userId)).toBe(1);
  });

  it('TASK-216 sin sesión responde 401', async () => {
    expect((await call('get', '/api/debts', null)).status).toBe(401);
    expect((await call('post', '/api/debts', null, newDebtBody())).status).toBe(401);
  });
});

describe('GET /api/debts', () => {
  it('TASK-216 lista las deudas con el resumen por dirección', async () => {
    const { cookie, userId } = await signedIn();
    const owe = await createDebt(userId, { startDate: START, principal: '1000.00' });
    const owed = await createDebt(userId, {
      startDate: START,
      direction: 'owed_to_me',
      person: 'Ana',
      principal: '300.00',
    });
    const res = await call('get', '/api/debts?view=debt', cookie);
    expect(res.status).toBe(200);
    const ids = listOf(res).debts.map((d) => d.id);
    expect(ids).toContain(owe.id);
    expect(ids).toContain(owed.id);
    expect(listOf(res).summary.iOwe).toBe('1000.00');
    expect(listOf(res).summary.owedToMe).toBe('300.00');
  });

  it('TASK-216 la vista por persona agrupa por person_key', async () => {
    const { cookie, userId } = await signedIn();
    await createDebt(userId, { startDate: START, person: 'Juan', principal: '100.00' });
    await createDebt(userId, { startDate: START, person: 'JUAN', principal: '50.00' });
    const res = await call('get', '/api/debts?view=person', cookie);
    expect(res.status).toBe(200);
    const byPerson = listOf(res).summary.byPerson ?? [];
    const juan = byPerson.filter((p) => p.personKey === 'juan');
    expect(juan).toHaveLength(1);
  });

  it('TASK-216 una vista desconocida responde 400 VALIDATION_ERROR', async () => {
    const { cookie } = await signedIn();
    const res = await call('get', '/api/debts?view=otra', cookie);
    expect(res.status).toBe(400);
    expect(problem(res).code).toBe('VALIDATION_ERROR');
  });

  it('TASK-216 leer calcula el interés al día sin escribir', async () => {
    const { cookie, userId } = await signedIn();
    const debt = await createDebt(userId, {
      startDate: START,
      interestRate: '2',
      interestPeriod: 'monthly',
    });
    const res = await call('get', '/api/debts', cookie);
    expect(res.status).toBe(200);
    const dto = listOf(res).debts.find((d) => d.id === debt.id);
    expect(dto).toBeDefined();
    expect(Number(dto?.interestAccrued)).toBeGreaterThan(0);
    const stored = await findStoredDebt(debt.id);
    expect(stored?.accruedThrough).toBe(START);
    expect(Number(stored?.interestUnpaid)).toBe(0);
  });
});

describe('POST /api/debts', () => {
  it('TASK-216 crea una deuda y aparece en GET /api/debts', async () => {
    const { cookie } = await signedIn();
    const body = newDebtBody();
    const res = await call('post', '/api/debts', cookie, body);
    expectSuccess(res);
    expect(debtOf(res).id).toBe(body.id);
    expect(debtOf(res).capitalOutstanding).toBe('1000.00');
    const stored = await findStoredDebt(body.id);
    expect(stored?.capitalOutstanding).toBe('1000.00');
    expect(stored?.accruedThrough).toBe(START);
    const list = await call('get', '/api/debts', cookie);
    expect(list.status).toBe(200);
    expect(listOf(list).debts.map((d) => d.id)).toContain(body.id);
  });

  it('TASK-216 dos POST con el mismo id dejan una fila', async () => {
    const { cookie, userId } = await signedIn();
    const body = newDebtBody();
    expectSuccess(await call('post', '/api/debts', cookie, body));
    expectSuccess(await call('post', '/api/debts', cookie, body));
    expect(await countDebts(userId)).toBe(1);
  });

  it('TASK-216 un cuerpo inválido responde 400 VALIDATION_ERROR', async () => {
    const { cookie, userId } = await signedIn();
    const res = await call('post', '/api/debts', cookie, newDebtBody({ principal: 'abc' }));
    expect(res.status).toBe(400);
    expect(problem(res).code).toBe('VALIDATION_ERROR');
    expect(await countDebts(userId)).toBe(0);
  });

  it('TASK-216 con 200 deudas la 201 responde 409 LIMIT_REACHED', async () => {
    const { cookie, userId } = await signedIn();
    for (let i = 0; i < 200; i += 1) await createDebt(userId, { startDate: START });
    const res = await call('post', '/api/debts', cookie, newDebtBody());
    expect(res.status).toBe(409);
    expect(problem(res).code).toBe('LIMIT_REACHED');
    expect(await countDebts(userId)).toBe(200);
  }, 60_000);

  it('TASK-216 con movimiento inicial "Debo" crea un ingreso en la cuenta', async () => {
    const { cookie, userId } = await signedIn();
    const acc = await createAccount(userId, { initialBalanceDate: ACCOUNT_SINCE });
    const transactionId = uuidv7();
    const body = newDebtBody({ initialMovement: { transactionId, accountId: acc.id } });
    const res = await call('post', '/api/debts', cookie, body);
    expectSuccess(res);
    const tx = await findStoredTransaction(transactionId);
    expect(tx?.kind).toBe('income');
    expect(tx?.entries[0]?.accountId).toBe(acc.id);
    expect(tx?.entries[0]?.amount).toBe('1000.00');
  });

  it('TASK-216 un movimiento inicial que deja el efectivo en negativo responde 422 NEGATIVE_BALANCE', async () => {
    const { cookie, userId } = await signedIn();
    const cash = await createAccount(userId, {
      type: 'cash',
      initialBalance: '0.00',
      initialBalanceDate: ACCOUNT_SINCE,
    });
    const body = newDebtBody({
      direction: 'owed_to_me',
      initialMovement: { transactionId: uuidv7(), accountId: cash.id },
    });
    const res = await call('post', '/api/debts', cookie, body);
    expect(res.status).toBe(422);
    expect(problem(res).code).toBe('NEGATIVE_BALANCE');
    expect(await countDebts(userId)).toBe(0);
    expect(await countTransactionsOf(userId)).toBe(0);
  });

  it('TASK-216 un movimiento inicial que toca dinero apartado responde 409 EARMARK_CONFIRMATION_REQUIRED', async () => {
    const { cookie, userId } = await signedIn();
    const acc = await createAccount(userId, {
      initialBalance: '500.00',
      initialBalanceDate: ACCOUNT_SINCE,
    });
    const goal = await createGoal(userId);
    await createAllocationEvent(userId, goal.id, acc.id, { amount: '400.00' });
    const body = newDebtBody({
      direction: 'owed_to_me',
      principal: '200.00',
      initialMovement: { transactionId: uuidv7(), accountId: acc.id },
    });
    const res = await call('post', '/api/debts', cookie, body);
    expect(res.status).toBe(409);
    expect(problem(res).code).toBe('EARMARK_CONFIRMATION_REQUIRED');
    expect(await countDebts(userId)).toBe(0);
  });
});

describe('PATCH /api/debts/:id', () => {
  it('TASK-216 edita la persona y la nota de una deuda activa', async () => {
    const { cookie, userId } = await signedIn();
    const debt = await createDebt(userId, { startDate: START });
    const res = await call('patch', `/api/debts/${debt.id}`, cookie, {
      person: 'Pedro',
      note: 'Préstamo',
    });
    expectSuccess(res);
    expect(debtOf(res).person).toBe('Pedro');
    const stored = await findStoredDebt(debt.id);
    expect(stored?.person).toBe('Pedro');
    expect(stored?.note).toBe('Préstamo');
  });

  it('TASK-216 un monto original menor al capital pagado responde 422 PRINCIPAL_BELOW_PAID', async () => {
    const { cookie, userId } = await signedIn();
    const debt = await createDebt(userId, {
      startDate: START,
      principal: '1000.00',
      capitalOutstanding: '600.00',
    });
    await createDebtPayment(userId, debt.id, { capitalPart: '400.00', date: PAY_DATE });
    const res = await call('patch', `/api/debts/${debt.id}`, cookie, { principal: '300.00' });
    expect(res.status).toBe(422);
    expect(problem(res).code).toBe('PRINCIPAL_BELOW_PAID');
    expect((await findStoredDebt(debt.id))?.principal).toBe('1000.00');
  });

  it('TASK-216 cambiar la fecha límite de una deuda pagada responde 422 FIELD_LOCKED', async () => {
    const { cookie, userId } = await signedIn();
    const debt = await createDebt(userId, {
      startDate: START,
      status: 'paid',
      capitalOutstanding: '0.00',
    });
    const res = await call('patch', `/api/debts/${debt.id}`, cookie, { dueDate: '2025-12-31' });
    expect(res.status).toBe(422);
    expect(problem(res).code).toBe('FIELD_LOCKED');
  });

  it('TASK-216 un campo fijo como la dirección responde 400 VALIDATION_ERROR', async () => {
    const { cookie, userId } = await signedIn();
    const debt = await createDebt(userId, { startDate: START });
    const res = await call('patch', `/api/debts/${debt.id}`, cookie, { direction: 'owed_to_me' });
    expect(res.status).toBe(400);
    expect(problem(res).code).toBe('VALIDATION_ERROR');
  });

  it('TASK-216 una deuda inexistente responde 404', async () => {
    const { cookie } = await signedIn();
    const res = await call('patch', `/api/debts/${uuidv7()}`, cookie, { note: 'x' });
    expect(res.status).toBe(404);
  });
});

describe('POST /api/debts/:id/payments', () => {
  it('TASK-216 registra un pago sin cuenta y baja el capital', async () => {
    const { cookie, userId } = await signedIn();
    const debt = await createDebt(userId, { startDate: START });
    const body = paymentBody();
    const res = await call('post', `/api/debts/${debt.id}/payments`, cookie, body);
    expectSuccess(res);
    expect(debtOf(res).capitalOutstanding).toBe('900.00');
    expect(debtOf(res).payments.map((p) => p.id)).toContain(body.id);
    expect((await findStoredDebt(debt.id))?.capitalOutstanding).toBe('900.00');
  });

  it('TASK-216 dos POST del mismo pago dejan un pago', async () => {
    const { cookie, userId } = await signedIn();
    const debt = await createDebt(userId, { startDate: START });
    const body = paymentBody();
    expectSuccess(await call('post', `/api/debts/${debt.id}/payments`, cookie, body));
    expectSuccess(await call('post', `/api/debts/${debt.id}/payments`, cookie, body));
    expect(await storedPaymentIdsOf(debt.id)).toEqual([body.id]);
    expect((await findStoredDebt(debt.id))?.capitalOutstanding).toBe('900.00');
  });

  it('TASK-216 un pago con cuenta crea el gasto vinculado de capital', async () => {
    const { cookie, userId } = await signedIn();
    const debt = await createDebt(userId, { startDate: START });
    const acc = await createAccount(userId, {
      initialBalance: '500.00',
      initialBalanceDate: ACCOUNT_SINCE,
    });
    const account = accountPart(acc.id);
    const res = await call(
      'post',
      `/api/debts/${debt.id}/payments`,
      cookie,
      paymentBody({ account }),
    );
    expectSuccess(res);
    const tx = await findStoredTransaction(account.capitalTransactionId);
    expect(tx?.kind).toBe('expense');
    expect(tx?.entries[0]?.amount).toBe('-100.00');
  });

  it('TASK-216 un pago mayor al saldo responde 422 PAYMENT_EXCEEDS_BALANCE con pending', async () => {
    const { cookie, userId } = await signedIn();
    const debt = await createDebt(userId, { startDate: START });
    const res = await call(
      'post',
      `/api/debts/${debt.id}/payments`,
      cookie,
      paymentBody({ amount: '1500.00', capitalPart: '1500.00' }),
    );
    expect(res.status).toBe(422);
    expect(problem(res).code).toBe('PAYMENT_EXCEEDS_BALANCE');
    expect(problem(res).pending).toBe('1000.00');
    expect(await storedPaymentIdsOf(debt.id)).toEqual([]);
  });

  it('TASK-216 un desglose que no suma el monto responde 422 SPLIT_INVALID con reason', async () => {
    const { cookie, userId } = await signedIn();
    const debt = await createDebt(userId, { startDate: START });
    const res = await call(
      'post',
      `/api/debts/${debt.id}/payments`,
      cookie,
      paymentBody({ amount: '100.00', capitalPart: '50.00' }),
    );
    expect(res.status).toBe(422);
    expect(problem(res).code).toBe('SPLIT_INVALID');
    expect(typeof problem(res).reason).toBe('string');
  });

  it('TASK-216 un pago con fecha futura responde 422 FUTURE_DATE', async () => {
    const { cookie, userId } = await signedIn();
    const debt = await createDebt(userId, { startDate: START });
    const res = await call(
      'post',
      `/api/debts/${debt.id}/payments`,
      cookie,
      paymentBody({ date: '2099-01-01' }),
    );
    expect(res.status).toBe(422);
    expect(problem(res).code).toBe('FUTURE_DATE');
  });

  it('TASK-216 pagar una deuda pagada responde 409 DEBT_CLOSED', async () => {
    const { cookie, userId } = await signedIn();
    const debt = await createDebt(userId, {
      startDate: START,
      status: 'paid',
      capitalOutstanding: '0.00',
    });
    const res = await call('post', `/api/debts/${debt.id}/payments`, cookie, paymentBody());
    expect(res.status).toBe(409);
    expect(problem(res).code).toBe('DEBT_CLOSED');
  });

  it('TASK-216 un pago que deja el efectivo en negativo responde 422 NEGATIVE_BALANCE', async () => {
    const { cookie, userId } = await signedIn();
    const debt = await createDebt(userId, { startDate: START });
    const cash = await createAccount(userId, {
      type: 'cash',
      initialBalance: '0.00',
      initialBalanceDate: ACCOUNT_SINCE,
    });
    const res = await call(
      'post',
      `/api/debts/${debt.id}/payments`,
      cookie,
      paymentBody({ account: accountPart(cash.id) }),
    );
    expect(res.status).toBe(422);
    expect(problem(res).code).toBe('NEGATIVE_BALANCE');
    expect(await storedPaymentIdsOf(debt.id)).toEqual([]);
  });

  it('TASK-216 un pago que toca dinero apartado responde 409 EARMARK_CONFIRMATION_REQUIRED', async () => {
    const { cookie, userId } = await signedIn();
    const debt = await createDebt(userId, { startDate: START });
    const acc = await createAccount(userId, {
      initialBalance: '500.00',
      initialBalanceDate: ACCOUNT_SINCE,
    });
    const goal = await createGoal(userId);
    await createAllocationEvent(userId, goal.id, acc.id, { amount: '450.00' });
    const res = await call(
      'post',
      `/api/debts/${debt.id}/payments`,
      cookie,
      paymentBody({ account: accountPart(acc.id) }),
    );
    expect(res.status).toBe(409);
    expect(problem(res).code).toBe('EARMARK_CONFIRMATION_REQUIRED');
    expect(await storedPaymentIdsOf(debt.id)).toEqual([]);
  });
});

describe('DELETE /api/debts/:id/payments/last', () => {
  it('TASK-216 elimina el último pago y repone el capital', async () => {
    const { cookie, userId } = await signedIn();
    const debt = await createDebt(userId, { startDate: START });
    const body = paymentBody();
    expectSuccess(await call('post', `/api/debts/${debt.id}/payments`, cookie, body));
    const res = await call('delete', `/api/debts/${debt.id}/payments/last`, cookie);
    expectSuccess(res);
    expect(await storedPaymentIdsOf(debt.id)).toEqual([]);
    expect((await findStoredDebt(debt.id))?.capitalOutstanding).toBe('1000.00');
  });

  it('TASK-216 en una deuda condonada responde 409 DEBT_FORGIVEN', async () => {
    const { cookie, userId } = await signedIn();
    const debt = await createDebt(userId, {
      startDate: START,
      status: 'forgiven',
      capitalOutstanding: '900.00',
      forgivenAmount: '900.00',
    });
    await createDebtPayment(userId, debt.id, { date: PAY_DATE });
    const res = await call('delete', `/api/debts/${debt.id}/payments/last`, cookie);
    expect(res.status).toBe(409);
    expect(problem(res).code).toBe('DEBT_FORGIVEN');
    expect(await storedPaymentIdsOf(debt.id)).toHaveLength(1);
  });

  it('TASK-216 quitar un cobro que deja el efectivo en negativo responde 422 NEGATIVE_BALANCE', async () => {
    const { cookie, userId } = await signedIn();
    const debt = await createDebt(userId, { startDate: START, direction: 'owed_to_me' });
    const cash = await createAccount(userId, {
      type: 'cash',
      initialBalance: '0.00',
      initialBalanceDate: ACCOUNT_SINCE,
    });
    const account = accountPart(cash.id);
    expectSuccess(
      await call('post', `/api/debts/${debt.id}/payments`, cookie, paymentBody({ account })),
    );
    // The 100.00 received is spent, so taking the income back leaves the cash below zero.
    await createLedgerTransaction(userId, {
      kind: 'expense',
      date: PAY_DATE,
      entries: [{ accountId: cash.id, amount: '-100.00' }],
    });
    const res = await call('delete', `/api/debts/${debt.id}/payments/last`, cookie);
    expect(res.status).toBe(422);
    expect(problem(res).code).toBe('NEGATIVE_BALANCE');
    expect(await storedPaymentIdsOf(debt.id)).toHaveLength(1);
  });

  it('TASK-216 sin pagos responde 404', async () => {
    const { cookie, userId } = await signedIn();
    const debt = await createDebt(userId, { startDate: START });
    const res = await call('delete', `/api/debts/${debt.id}/payments/last`, cookie);
    expect(res.status).toBe(404);
  });
});

describe('POST /api/debts/:id/forgive', () => {
  it('TASK-216 condona la deuda con su saldo pendiente y sin movimientos', async () => {
    const { cookie, userId } = await signedIn();
    const debt = await createDebt(userId, { startDate: START });
    const before = await countTransactionsOf(userId);
    const res = await call('post', `/api/debts/${debt.id}/forgive`, cookie);
    expectSuccess(res);
    expect(debtOf(res).status).toBe('forgiven');
    expect(debtOf(res).forgivenAmount).toBe('1000.00');
    const stored = await findStoredDebt(debt.id);
    expect(stored?.status).toBe('forgiven');
    expect(stored?.forgivenAmount).toBe('1000.00');
    expect(await countTransactionsOf(userId)).toBe(before);
  });

  it('TASK-216 condonar una deuda pagada responde 409 DEBT_CLOSED', async () => {
    const { cookie, userId } = await signedIn();
    const debt = await createDebt(userId, {
      startDate: START,
      status: 'paid',
      capitalOutstanding: '0.00',
    });
    const res = await call('post', `/api/debts/${debt.id}/forgive`, cookie);
    expect(res.status).toBe(409);
    expect(problem(res).code).toBe('DEBT_CLOSED');
  });
});

describe('DELETE /api/debts/:id', () => {
  const debtWithInitialMovement = async (cookie: string, userId: string) => {
    const acc = await createAccount(userId, { initialBalanceDate: ACCOUNT_SINCE });
    const transactionId = uuidv7();
    const body = newDebtBody({ initialMovement: { transactionId, accountId: acc.id } });
    expectSuccess(await call('post', '/api/debts', cookie, body));
    return { debtId: body.id, transactionId };
  };

  it('TASK-216 elimina una deuda sin movimientos', async () => {
    const { cookie, userId } = await signedIn();
    const debt = await createDebt(userId, { startDate: START });
    const res = await call('delete', `/api/debts/${debt.id}`, cookie);
    expectSuccess(res);
    expect(await findStoredDebt(debt.id)).toBeNull();
  });

  it('TASK-216 con movimientos y sin elección responde 409 MOVEMENTS_CHOICE_REQUIRED con count', async () => {
    const { cookie, userId } = await signedIn();
    const { debtId } = await debtWithInitialMovement(cookie, userId);
    const res = await call('delete', `/api/debts/${debtId}`, cookie);
    expect(res.status).toBe(409);
    expect(problem(res).code).toBe('MOVEMENTS_CHOICE_REQUIRED');
    expect(problem(res).count).toBe(1);
    expect(await findStoredDebt(debtId)).not.toBeNull();
  });

  it('TASK-216 con movements=keep conserva los movimientos como manuales', async () => {
    const { cookie, userId } = await signedIn();
    const { debtId, transactionId } = await debtWithInitialMovement(cookie, userId);
    const res = await call('delete', `/api/debts/${debtId}?movements=keep`, cookie, {
      movements: 'keep',
    });
    expectSuccess(res);
    expect(await findStoredDebt(debtId)).toBeNull();
    const tx = await findStoredTransaction(transactionId);
    expect(tx?.deletedAt).toBeNull();
    expect(tx?.origin).toBe('manual');
  });

  it('TASK-216 con movements=delete borra los movimientos', async () => {
    const { cookie, userId } = await signedIn();
    const { debtId, transactionId } = await debtWithInitialMovement(cookie, userId);
    const res = await call('delete', `/api/debts/${debtId}?movements=delete`, cookie, {
      movements: 'delete',
    });
    expectSuccess(res);
    expect(await findStoredDebt(debtId)).toBeNull();
    const tx = await findStoredTransaction(transactionId);
    expect(tx === null || tx.deletedAt !== null).toBe(true);
  });

  it('TASK-216 una deuda inexistente responde 404', async () => {
    const { cookie } = await signedIn();
    expect((await call('delete', `/api/debts/${uuidv7()}`, cookie)).status).toBe(404);
  });
});
