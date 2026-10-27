import type { DashboardDto, UpcomingItemDto } from '@finanzas/contracts';
import type { Express } from 'express';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { buildContainer, createApp, type Container } from '../../src/composition/container.js';
import { parseEnv } from '../../src/infrastructure/config/env.js';
import { createAccount } from '../factories/account.factory.js';
import { createCategory } from '../factories/category.factory.js';
import { createDebt } from '../factories/debt.factory.js';
import { createLedgerTransaction, deleteLedgerOf } from '../factories/ledger.factory.js';
import { disconnectTestPrisma, testPrisma } from '../integration/setup/db.js';

/**
 * `GET /api/dashboard?month` block `upcoming` (plan §4.8.1, RF-M8-09, RF-M4-08): the due dates of
 * the next 7 days, debts in both directions and cards (cut and payment day; a day the month does
 * not have falls on its last day). In a past month the block is hidden. Only with RELEASE >= 1.1.
 *
 * The server reads "today" from `new Date()` (system clock), so the card case fakes only `Date`
 * at a moment earlier than the real one (the session, created at the real time, stays valid).
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

const db = testPrisma();
let container: Container;
let app: Express;
const usedEmails: string[] = [];
const usedUsers: string[] = [];
const originalRelease = process.env['RELEASE'];

const sessionCookieOf = (res: { headers: Record<string, unknown> }): string => {
  const raw = res.headers['set-cookie'];
  const list = typeof raw === 'string' ? [raw] : Array.isArray(raw) ? (raw as unknown[]) : [];
  const header = list.find(
    (c): c is string => typeof c === 'string' && c.startsWith(`${COOKIE_NAME}=`),
  );
  if (header === undefined) throw new Error('the response sets no session cookie');
  return header.split(';')[0] ?? '';
};

interface Account {
  cookie: string;
  userId: string;
}

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

const dashboard = (month: string, cookie: string) =>
  request(app).get(`/api/dashboard?month=${month}`).set('Cookie', cookie);

const bodyOf = (res: { body: unknown }) => res.body as DashboardDto;

interface Today {
  month: string;
  previousMonth: string;
  in5: string;
  in8: string;
  in3: string;
}

/** Today's calendar data in the timezone of the user (real clock). */
async function todayOf(userId: string): Promise<Today> {
  const rows = await db.$queryRaw<Today[]>`
    SELECT to_char(d, 'YYYY-MM') AS month,
           to_char(d - interval '1 month', 'YYYY-MM') AS "previousMonth",
           to_char(d + 5, 'YYYY-MM-DD') AS in5,
           to_char(d + 8, 'YYYY-MM-DD') AS in8,
           to_char(d + 3, 'YYYY-MM-DD') AS in3
      FROM (SELECT (now() AT TIME ZONE timezone)::date AS d
              FROM auth_user WHERE id = ${userId}::uuid) t`;
  const found = rows[0];
  if (found === undefined) throw new Error('the user has no timezone');
  return found;
}

/** The items of the block that come from the given source (a debt or a card). */
const itemsOf = (
  upcoming: UpcomingItemDto[] | undefined,
  source: { id: string; name?: string },
): UpcomingItemDto[] =>
  (upcoming ?? []).filter(
    (item) => item.id === source.id || (source.name !== undefined && item.name === source.name),
  );

beforeAll(async () => {
  process.env['RELEASE'] = '1.1';
  container = await Promise.resolve(buildContainer(parseEnv(envSource())));
  app = await Promise.resolve(createApp(container));
}, 30_000);

afterEach(() => {
  vi.useRealTimers();
  process.env['RELEASE'] = '1.1';
});

afterAll(async () => {
  vi.useRealTimers();
  if (originalRelease === undefined) delete process.env['RELEASE'];
  else process.env['RELEASE'] = originalRelease;
  await deleteLedgerOf(usedUsers);
  await db.$executeRaw`DELETE FROM debt_payment WHERE user_id = ANY(${usedUsers}::uuid[])`;
  await db.$executeRaw`DELETE FROM debt WHERE user_id = ANY(${usedUsers}::uuid[])`;
  await db.$executeRaw`DELETE FROM auth_user WHERE email = ANY(${usedEmails}::text[])`;
  await db.$executeRaw`DELETE FROM email_outbox WHERE to_address = ANY(${usedEmails}::text[])`;
  await disconnectTestPrisma();
  await container.prisma.$disconnect();
}, 60_000);

describe('GET /api/dashboard bloque de próximos pagos y deudas', () => {
  it('RF-M8-09 una deuda que vence en 5 días aparece; una que vence en 8, no', async () => {
    const { cookie, userId } = await signedIn();
    const today = await todayOf(userId);
    const soon = await createDebt(userId, {
      person: 'Pronto Cinco',
      startDate: '2020-01-01',
      dueDate: today.in5,
    });
    const late = await createDebt(userId, {
      person: 'Tarde Ocho',
      startDate: '2020-01-01',
      dueDate: today.in8,
    });

    const res = await dashboard(today.month, cookie);

    expect(res.status).toBe(200);
    const { upcoming } = bodyOf(res);
    expect(Array.isArray(upcoming)).toBe(true);
    const found = itemsOf(upcoming, { id: soon.id, name: soon.person });
    expect(found).toHaveLength(1);
    expect(found[0]?.dueDate).toBe(today.in5);
    expect(itemsOf(upcoming, { id: late.id, name: late.person })).toEqual([]);
  });

  it('RF-M8-09 lista las deudas en ambas direcciones', async () => {
    const { cookie, userId } = await signedIn();
    const today = await todayOf(userId);
    const iOwe = await createDebt(userId, {
      direction: 'i_owe',
      person: 'Debo Yo',
      startDate: '2020-01-01',
      dueDate: today.in3,
    });
    const owedToMe = await createDebt(userId, {
      direction: 'owed_to_me',
      person: 'Me Debe',
      startDate: '2020-01-01',
      dueDate: today.in3,
    });

    const res = await dashboard(today.month, cookie);

    expect(res.status).toBe(200);
    const { upcoming } = bodyOf(res);
    expect(itemsOf(upcoming, { id: iOwe.id, name: iOwe.person })).toHaveLength(1);
    expect(itemsOf(upcoming, { id: owedToMe.id, name: owedToMe.person })).toHaveLength(1);
  });

  it('RF-M4-08 una tarjeta con pago el día 31 en un mes de 30 días aparece el 30', async () => {
    const { cookie, userId } = await signedIn();
    const card = await createAccount(userId, {
      type: 'credit_card',
      initialBalanceDate: '2020-01-01',
      cardCutDay: 15,
      cardPayDay: 31,
    });
    const category = await createCategory(userId, { kind: 'expense' });
    await createLedgerTransaction(userId, {
      kind: 'expense',
      date: '2026-09-10',
      categoryId: category.id,
      entries: [{ accountId: card.id, amount: '-200.00' }],
    });
    // 2026-09-27 at noon in Bolivia (UTC-4); September has 30 days.
    vi.useFakeTimers({ toFake: ['Date'], now: new Date('2026-09-27T16:00:00.000Z') });

    const res = await dashboard('2026-09', cookie);

    expect(res.status).toBe(200);
    const found = itemsOf(bodyOf(res).upcoming, { id: card.id, name: card.name });
    expect(found.map((item) => item.dueDate)).toEqual(['2026-09-30']);
  });

  it('RF-M8-09 en un mes pasado el bloque no aparece', async () => {
    const { cookie, userId } = await signedIn();
    const today = await todayOf(userId);
    await createDebt(userId, {
      person: 'Mes Pasado',
      startDate: '2020-01-01',
      dueDate: today.in3,
    });

    const res = await dashboard(today.previousMonth, cookie);

    expect(res.status).toBe(200);
    const { upcoming } = bodyOf(res);
    expect(upcoming === undefined || upcoming.length === 0).toBe(true);
  });

  it('RF-M8-09 con RELEASE=1.0 el bloque no viene en la respuesta', async () => {
    const { cookie, userId } = await signedIn();
    const today = await todayOf(userId);
    await createDebt(userId, { startDate: '2020-01-01', dueDate: today.in3 });
    process.env['RELEASE'] = '1.0';

    const res = await dashboard(today.month, cookie);

    expect(res.status).toBe(200);
    expect(res.body).not.toHaveProperty('upcoming');
  });

  it('RNF-14 el usuario B nunca ve los vencimientos de A', async () => {
    const a = await signedIn();
    const b = await signedIn();
    const today = await todayOf(a.userId);
    const debt = await createDebt(a.userId, {
      person: 'Solo De A',
      startDate: '2020-01-01',
      dueDate: today.in3,
    });

    const ofA = bodyOf(await dashboard(today.month, a.cookie)).upcoming;
    expect(itemsOf(ofA, { id: debt.id, name: debt.person })).toHaveLength(1);
    const ofB = bodyOf(await dashboard(today.month, b.cookie)).upcoming;
    expect(itemsOf(ofB, { id: debt.id, name: debt.person })).toEqual([]);
  });
});
