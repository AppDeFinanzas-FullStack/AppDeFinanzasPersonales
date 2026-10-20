import { RatesCurrentDto } from '@finanzas/contracts';
import { Decimal } from 'decimal.js';
import type { Express } from 'express';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { buildContainer, createApp, type Container } from '../../src/composition/container.js';
import { parseEnv } from '../../src/infrastructure/config/env.js';
import type * as FakeRatesModule from '../../src/infrastructure/integrations/paralelo-bo.fake.js';
import type { FakeRatesGateway } from '../../src/infrastructure/integrations/paralelo-bo.fake.js';
import { disconnectTestPrisma, testPrisma } from '../integration/setup/db.js';

/**
 * `GET /api/rates/current` and `GET /api/rates/history?kind&range` (plan §4.3.2), over the test
 * database with fake integrations. The plan fixes the routes, `RatesCurrentDto`,
 * `RateHistoryQuery` and the fake paralelo.bo gateway (`configure`, `calls`, `delayMs`). These
 * tests assume:
 * - The fake paralelo.bo gateway the container builds with `INTEGRATIONS=fake` is the one made by
 *   `createFakeRatesGateway`; the file wraps that factory to reach the instance.
 * - The background refresh goes through `fx.fetchParallel` and its `fx_refresh` lease.
 * - `history` answers the points either as a JSON array or as an object with one array of
 *   points; the plan does not name the field, so only the count is checked.
 *
 * `market_rate` is global (ADR-12): the file saves its rows, empties the table before each test
 * and puts the rows back at the end. HTTP files run one after another.
 */
const captured = vi.hoisted(() => ({ fakes: [] as FakeRatesGateway[] }));

vi.mock('../../src/infrastructure/integrations/paralelo-bo.fake.js', async (importOriginal) => {
  const original = await importOriginal<typeof FakeRatesModule>();
  return {
    ...original,
    createFakeRatesGateway: (opts?: FakeRatesModule.FakeRatesOptions) => {
      const fake = original.createFakeRatesGateway(opts);
      captured.fakes.push(fake);
      return fake;
    },
  };
});

const WEB_ORIGIN = 'http://localhost:5173';
const COOKIE_NAME = '__Secure-better-auth.session_token';
const BOLIVIA = 'America/La_Paz';
const MIN = 60_000;
const DAY = 24 * 60 * MIN;

const envSource = (): Record<string, string> => ({
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
});

interface Problem {
  code?: string;
  status?: number;
}
const problem = (res: { body: unknown }) => res.body as Problem;

type Kind = 'parallel_bid' | 'parallel_ask' | 'parallel_median' | 'official';
type Source = 'paralelo_bo' | 'bcb' | 'seed';

interface SavedRate {
  kind: string;
  rateDate: string;
  value: string;
  observedAt: Date;
  source: string;
}

const db = testPrisma();
let container: Container;
let app: Express;
let fake: FakeRatesGateway;
let cookie: string;
let savedRates: SavedRate[] = [];
const usedEmails: string[] = [];

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

async function signedInCookie(): Promise<string> {
  const support = container.testSupport;
  if (support === null) throw new Error('test support is off');
  const { email, password } = await support.createUser();
  usedEmails.push(email);
  const res = await request(app)
    .post('/api/auth/sign-in')
    .set('Origin', WEB_ORIGIN)
    .send({ email, password });
  expect(res.status).toBe(200);
  return sessionCookieOf(res);
}

const getPath = (path: string, withCookie: string | null = cookie) => {
  const req = request(app).get(path);
  if (withCookie !== null) req.set('Cookie', withCookie);
  return req;
};

/** Today's date in Bolivia, the calendar of `rate_date`. */
const boliviaDay = (instant: Date): string =>
  new Intl.DateTimeFormat('en-CA', {
    timeZone: BOLIVIA,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(instant);

const daysBefore = (date: string, days: number): string =>
  new Date(new Date(`${date}T12:00:00Z`).getTime() - days * DAY).toISOString().slice(0, 10);

async function marketRate(
  kind: Kind,
  rateDate: string,
  value: string,
  observedAt: Date,
  source: Source = 'paralelo_bo',
): Promise<void> {
  await db.$executeRaw`
    INSERT INTO market_rate (kind, rate_date, value, observed_at, source)
    VALUES (${kind}::market_rate_kind, ${rateDate}::date, ${value}::numeric,
            ${observedAt}, ${source}::rate_source)`;
}

/** Today's parallel bid, ask and median captured at `observedAt`. */
async function parallelToday(observedAt: Date): Promise<void> {
  const today = boliviaDay(new Date());
  await marketRate('parallel_bid', today, '10.30', observedAt);
  await marketRate('parallel_ask', today, '10.50', observedAt);
  await marketRate('parallel_median', today, '10.40', observedAt);
}

/** A quote the fake returns, captured now, so a refresh leaves the capture fresh. */
const freshQuote = () => ({
  median: new Decimal('10.45'),
  bid: new Decimal('10.35'),
  ask: new Decimal('10.55'),
  observedAt: new Date(),
});

/** Waits until the background refresh has called the source and released the lease. */
async function refreshSettled(callsBefore: number, timeoutMs = 8000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const rows = await db.$queryRaw<{ free: boolean }[]>`
      SELECT (locked_until IS NULL OR locked_until < now()) AS free
        FROM job_run WHERE job = 'fx_refresh'`;
    const free = rows[0]?.free ?? true;
    if (fake.calls.parallel > callsBefore && free) return;
    await sleep(50);
  }
  throw new Error('the background refresh did not finish');
}

/** Waits until no refresh holds the `fx_refresh` lease. */
async function leaseFree(timeoutMs = 8000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const rows = await db.$queryRaw<{ free: boolean }[]>`
      SELECT (locked_until IS NULL OR locked_until < now()) AS free
        FROM job_run WHERE job = 'fx_refresh'`;
    if (rows[0]?.free ?? true) return;
    await sleep(50);
  }
}

/** Points of a history answer: the array itself, or the one array the object holds. */
function pointsOf(body: unknown): unknown[] {
  if (Array.isArray(body)) return body as unknown[];
  if (typeof body === 'object' && body !== null) {
    const arrays = Object.values(body as Record<string, unknown>).filter(Array.isArray);
    if (arrays.length === 1) return arrays[0] as unknown[];
  }
  throw new Error('the history answer holds no list of points');
}

beforeAll(async () => {
  container = await Promise.resolve(buildContainer(parseEnv(envSource())));
  app = await Promise.resolve(createApp(container));
  const last = captured.fakes.at(-1);
  if (last === undefined) throw new Error('the container built no fake paralelo.bo gateway');
  fake = last;
  savedRates = await db.$queryRaw<SavedRate[]>`
    SELECT kind::text AS kind, rate_date::text AS "rateDate", value::text AS value,
           observed_at AS "observedAt", source::text AS source
      FROM market_rate`;
  cookie = await signedInCookie();
}, 30_000);

beforeEach(async () => {
  await leaseFree();
  await db.$executeRaw`DELETE FROM market_rate`;
  await db.$executeRaw`UPDATE job_run SET locked_until = NULL WHERE job = 'fx_refresh'`;
  fake.configure({ delayMs: 0, failure: null, parallel: freshQuote() });
});

afterEach(async () => {
  fake.configure({ delayMs: 0 });
  await leaseFree();
}, 15_000);

afterAll(async () => {
  await leaseFree();
  await db.$executeRaw`DELETE FROM market_rate`;
  for (const row of savedRates) {
    await db.$executeRaw`
      INSERT INTO market_rate (kind, rate_date, value, observed_at, source)
      VALUES (${row.kind}::market_rate_kind, ${row.rateDate}::date, ${row.value}::numeric,
              ${row.observedAt}, ${row.source}::rate_source)`;
  }
  await db.$executeRaw`DELETE FROM auth_user WHERE email = ANY(${usedEmails}::text[])`;
  await db.$executeRaw`DELETE FROM email_outbox WHERE to_address = ANY(${usedEmails}::text[])`;
  await disconnectTestPrisma();
  await container.prisma.$disconnect();
}, 30_000);

describe('GET /api/rates/current', () => {
  it('TASK-086 sin sesión responde 401', async () => {
    expect((await getPath('/api/rates/current', null)).status).toBe(401);
  });

  it('TASK-086 responde 200 con un RatesCurrentDto', async () => {
    await parallelToday(new Date(Date.now() - 10_000));
    const res = await getPath('/api/rates/current');
    expect(res.status).toBe(200);
    expect(RatesCurrentDto.safeParse(res.body).success).toBe(true);
  });

  it('RNF-04 con la fuente lenta (5 s) y la captura vieja responde en menos de 100 ms', async () => {
    await parallelToday(new Date(Date.now() - 10_000));
    // Warm-up with a fresh capture: nothing is refreshed and the connections are open.
    expect((await getPath('/api/rates/current')).status).toBe(200);
    await db.$executeRaw`
      UPDATE market_rate SET observed_at = ${new Date(Date.now() - 5 * MIN)}`;
    fake.configure({ delayMs: 5000, parallel: freshQuote() });
    const callsBefore = fake.calls.parallel;

    const started = performance.now();
    const res = await getPath('/api/rates/current');
    const elapsed = performance.now() - started;

    expect(res.status).toBe(200);
    expect(elapsed).toBeLessThan(100);
    const body = res.body as RatesCurrentDto;
    expect(body.references.parallel_median?.value).toBe('10.40');
    await refreshSettled(callsBefore, 10_000);
  }, 20_000);

  it('RF-M3-04 una captura de hace más de 1 minuto dispara la actualización una sola vez', async () => {
    await parallelToday(new Date(Date.now() - 2 * MIN));
    fake.configure({ delayMs: 300, parallel: freshQuote() });
    const callsBefore = fake.calls.parallel;

    const answers = await Promise.all([
      getPath('/api/rates/current'),
      getPath('/api/rates/current'),
      getPath('/api/rates/current'),
    ]);
    for (const res of answers) expect(res.status).toBe(200);
    await refreshSettled(callsBefore);

    // The refresh left a fresh capture: a later read does not refresh again.
    expect((await getPath('/api/rates/current')).status).toBe(200);
    await sleep(500);
    await leaseFree();
    expect(fake.calls.parallel - callsBefore).toBe(1);

    const rows = await db.$queryRaw<{ value: string }[]>`
      SELECT value::text AS value FROM market_rate WHERE kind = 'parallel_median'`;
    expect(rows.map((r) => new Decimal(r.value).toFixed(2))).toEqual(['10.45']);
  }, 20_000);

  it('RF-M3-04 una captura de menos de 1 minuto no dispara la actualización', async () => {
    await parallelToday(new Date(Date.now() - 10_000));
    const callsBefore = fake.calls.parallel;

    expect((await getPath('/api/rates/current')).status).toBe(200);
    await sleep(500);
    await leaseFree();

    expect(fake.calls.parallel).toBe(callsBefore);
  });

  it('RNF-27 RF-M3-05 cada valor incluye su fuente y su observedAt', async () => {
    const today = boliviaDay(new Date());
    const parallelAt = new Date(Date.now() - 20_000);
    const officialAt = new Date(Date.now() - 3 * 60 * MIN);
    await parallelToday(parallelAt);
    await marketRate('official', today, '6.96', officialAt, 'bcb');

    const res = await getPath('/api/rates/current');
    expect(res.status).toBe(200);
    const body = res.body as RatesCurrentDto;

    for (const kind of ['parallel_bid', 'parallel_ask', 'parallel_median'] as const) {
      const reference = body.references[kind];
      expect(reference?.source).toBe('paralelo_bo');
      expect(new Date(reference?.observedAt ?? '').getTime()).toBe(parallelAt.getTime());
    }
    expect(body.references.official?.source).toBe('bcb');
    expect(new Date(body.references.official?.observedAt ?? '').getTime()).toBe(
      officialAt.getTime(),
    );
  });
});

describe('GET /api/rates/history', () => {
  it('TASK-086 sin sesión responde 401', async () => {
    const res = await getPath('/api/rates/history?kind=parallel_median&range=30d', null);
    expect(res.status).toBe(401);
  });

  it('TASK-086 history con range=30d devuelve como máximo 30 puntos', async () => {
    const today = boliviaDay(new Date());
    const observedAt = new Date(Date.now() - 10_000);
    for (let i = 0; i < 45; i += 1) {
      await marketRate('parallel_median', daysBefore(today, i), '10.40', observedAt);
    }

    const res = await getPath('/api/rates/history?kind=parallel_median&range=30d');
    expect(res.status).toBe(200);
    const points = pointsOf(res.body as unknown);
    expect(points.length).toBeGreaterThan(0);
    expect(points.length).toBeLessThanOrEqual(30);
  });

  it('TASK-086 un rango fuera de RateHistoryQuery responde 400 VALIDATION_ERROR', async () => {
    const res = await getPath('/api/rates/history?kind=parallel_median&range=15d');
    expect(res.status).toBe(400);
    expect(problem(res).code).toBe('VALIDATION_ERROR');
  });

  it('TASK-086 sin kind responde 400 VALIDATION_ERROR', async () => {
    const res = await getPath('/api/rates/history?range=30d');
    expect(res.status).toBe(400);
    expect(problem(res).code).toBe('VALIDATION_ERROR');
  });
});
