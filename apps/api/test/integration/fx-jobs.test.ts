import { Decimal } from 'decimal.js';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';

import { createFxJobs } from '../../src/application/jobs/fx.js';
import type { Clock } from '../../src/application/ports/clock.js';
import type { JobRuns } from '../../src/application/ports/job-runs.js';
import type { MarketRateKind, RateSource } from '../../src/application/ports/repositories.js';
import type { UnitOfWork } from '../../src/application/ports/unit-of-work.js';
import { buildContainer } from '../../src/composition/container.js';
import { parseEnv } from '../../src/infrastructure/config/env.js';
import { createFakeBcbGateway } from '../../src/infrastructure/integrations/bcb.fake.js';
import { createFakeRatesGateway } from '../../src/infrastructure/integrations/paralelo-bo.fake.js';
import { createJobRuns } from '../../src/infrastructure/persistence/job-runs.js';
import { createCurrencyRepository } from '../../src/infrastructure/persistence/repositories/currency.repository.js';
import { createMarketRateRepository } from '../../src/infrastructure/persistence/repositories/market-rate.repository.js';
import { createUserFxEventRepository } from '../../src/infrastructure/persistence/repositories/user-fx-event.repository.js';
import { createUnitOfWork } from '../../src/infrastructure/persistence/unit-of-work.js';
import { disconnectTestPrisma, testDatabaseUrl, testPrisma } from './setup/db.js';

/**
 * The plan fixes the jobs (`fx.fetchParallel`, `fx.fetchOfficial`), the `RatesGateway` port, the
 * `fx_refresh` lease and `container.jobs.registerJob` (plan §4.3.2, §4.3.3, §4.0), but not how the
 * module `application/jobs/fx.ts` is built. These tests assume:
 * - `createFxJobs({ rates, bcb, uow, jobRuns, clock })` returns `{ fetchParallel(opts?), fetchOfficial() }`,
 *   the two handlers of the jobs. `rates` is the `RatesGateway` of paralelo.bo and `bcb` the
 *   BCB fallback (`Pick<RatesGateway, 'fetchOfficial'>`).
 * - `fetchParallel()` runs only if the latest `parallel_median` capture is older than 60 minutes;
 *   `fetchParallel({ force: true })` is the on-demand run and skips that check.
 * - `fetchOfficial()` runs only if no official rate was captured (`observed_at`) today in Bolivia.
 * - Both take the `fx_refresh` lease of `job_run` (a lease in force makes them do nothing) and
 *   never throw because a source fails.
 * - The day of the parallel rates is the Bolivian day (America/La_Paz) of the clock; the official
 *   one is stored at the `effectiveDate` of the quote, or today when the source gives none.
 * - The container registers both jobs in `container.jobs`.
 */
const prisma = testPrisma();
const jobRuns: JobRuns = createJobRuns(prisma);

const NIL_USER = '00000000-0000-0000-0000-000000000000';
const uow: UnitOfWork = createUnitOfWork(
  prisma,
  (tx, userId) => ({
    marketRates: createMarketRateRepository(tx),
    currencies: createCurrencyRepository(tx, userId ?? NIL_USER),
    userFxEvents: createUserFxEventRepository(tx, userId ?? NIL_USER),
  }),
);

const TEST_ERA = '2090-01-01';
const MIN = 60_000;

const NOW = new Date('2090-03-10T15:00:00Z'); // 11:00 in La Paz
const TODAY = '2090-03-10';

function fakeClock(start: Date = NOW): Clock {
  return {
    now: () => start,
    todayFor: (timezone) =>
      new Intl.DateTimeFormat('en-CA', {
        timeZone: timezone,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
      }).format(start),
  };
}

const ago = (ms: number, from: Date = NOW) => new Date(from.getTime() - ms);

const sleep = (ms: number) =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });

function parallelQuote(
  median: string,
  bid: string | null,
  ask: string | null,
  observedAt: Date = NOW,
) {
  return {
    median: new Decimal(median),
    bid: bid === null ? null : new Decimal(bid),
    ask: ask === null ? null : new Decimal(ask),
    observedAt,
  };
}

function officialQuote(value: string, effectiveDate: string | null, observedAt: Date = NOW) {
  return { value: new Decimal(value), effectiveDate, observedAt };
}

function setup(clock: Clock = fakeClock()) {
  const rates = createFakeRatesGateway({ parallel: parallelQuote('11.83', '11.81', '11.85') });
  const bcb = createFakeBcbGateway();
  const jobs = createFxJobs({ rates, bcb, uow, jobRuns, clock });
  return { rates, bcb, jobs };
}

async function seed(
  kind: MarketRateKind,
  rateDate: string,
  value: string,
  observedAt: Date,
  source: RateSource = 'paralelo_bo',
): Promise<void> {
  await uow.run((repos) =>
    repos.marketRates.upsertIfNewer({
      kind,
      rateDate,
      value: new Decimal(value),
      observedAt,
      source,
    }),
  );
}

interface StoredRate {
  kind: string;
  rateDate: string;
  value: string;
  observedAt: Date;
  source: string;
}

/** Rates of the test era, read outside of the code under test. */
async function storedRates(): Promise<StoredRate[]> {
  return prisma.$queryRaw<StoredRate[]>`
    SELECT kind::text AS kind, rate_date::text AS "rateDate", value::text AS value,
           observed_at AS "observedAt", source::text AS source
      FROM market_rate
     WHERE rate_date >= ${TEST_ERA}::date
     ORDER BY kind::text, rate_date`;
}

async function storedOf(kind: string): Promise<StoredRate[]> {
  return (await storedRates()).filter((row) => row.kind === kind);
}

async function leaseRow(job: string) {
  const rows = await prisma.$queryRaw<{ lockedUntil: Date | null; lastStartedAt: Date | null }[]>`
    SELECT locked_until AS "lockedUntil", last_started_at AS "lastStartedAt"
      FROM job_run WHERE job = ${job}`;
  return rows[0];
}

async function holdLease(job: string, lockedUntil: Date): Promise<void> {
  await prisma.$executeRaw`
    INSERT INTO job_run (job, last_started_at, locked_until)
    VALUES (${job}, ${ago(MIN, lockedUntil)}::timestamptz, ${lockedUntil}::timestamptz)
    ON CONFLICT (job) DO UPDATE SET locked_until = EXCLUDED.locked_until`;
}

beforeEach(async () => {
  await prisma.$executeRaw`DELETE FROM market_rate WHERE rate_date >= ${TEST_ERA}::date`;
  await prisma.$executeRaw`DELETE FROM job_run WHERE job = 'fx_refresh'`;
});

afterAll(async () => {
  await prisma.$executeRaw`DELETE FROM market_rate WHERE rate_date >= ${TEST_ERA}::date`;
  await prisma.$executeRaw`DELETE FROM job_run WHERE job = 'fx_refresh'`;
  await disconnectTestPrisma();
});

// ---------- fx.fetchParallel ----------

describe('fx.fetchParallel: cuándo consulta', () => {
  it('RF-M3-04 con una captura de hace 30 minutos no consulta la fuente', async () => {
    await seed('parallel_median', TODAY, '11.50', ago(30 * MIN));
    const { rates, jobs } = setup();

    await jobs.fetchParallel();

    expect(rates.calls.parallel).toBe(0);
    expect((await storedOf('parallel_median'))[0]?.value).toBe('11.50');
  });

  it('RF-M3-04 con una captura de hace 61 minutos consulta la fuente y guarda el valor nuevo', async () => {
    await seed('parallel_median', TODAY, '11.50', ago(61 * MIN));
    const { rates, jobs } = setup();

    await jobs.fetchParallel();

    expect(rates.calls.parallel).toBe(1);
    const rows = await storedOf('parallel_median');
    expect(rows).toHaveLength(1);
    expect(rows[0]?.value).toBe('11.83');
  });

  it('RF-M3-04 a pedido consulta aunque la última captura sea de hace 30 minutos', async () => {
    await seed('parallel_median', TODAY, '11.50', ago(30 * MIN));
    const { rates, jobs } = setup();

    await jobs.fetchParallel({ force: true });

    expect(rates.calls.parallel).toBe(1);
    expect((await storedOf('parallel_median'))[0]?.value).toBe('11.83');
  });

  it('RF-M3-04 sin ninguna captura del día consulta la fuente', async () => {
    const { rates, jobs } = setup();

    await jobs.fetchParallel();

    expect(rates.calls.parallel).toBe(1);
  });
});

describe('fx.fetchParallel: qué guarda', () => {
  it('RF-M3-04 guarda mediana, compra y venta del día de Bolivia con la fuente paralelo_bo', async () => {
    const { jobs } = setup();

    await jobs.fetchParallel({ force: true });

    const rows = await storedRates();
    expect(rows.map((r) => [r.kind, r.rateDate, r.value, r.source])).toEqual([
      ['parallel_ask', TODAY, '11.85', 'paralelo_bo'],
      ['parallel_bid', TODAY, '11.81', 'paralelo_bo'],
      ['parallel_median', TODAY, '11.83', 'paralelo_bo'],
    ]);
    expect(rows.every((r) => r.observedAt.getTime() === NOW.getTime())).toBe(true);
  });

  it('RF-M3-04 el día es el de Bolivia: a las 02:00 UTC todavía es el día anterior', async () => {
    const lateUtc = new Date('2090-03-11T02:00:00Z'); // 22:00 of the 10th in La Paz
    const { jobs, rates } = setup(fakeClock(lateUtc));
    rates.configure({ parallel: parallelQuote('11.83', '11.81', '11.85', lateUtc) });

    await jobs.fetchParallel({ force: true });

    const rows = await storedOf('parallel_median');
    expect(rows.map((r) => r.rateDate)).toEqual(['2090-03-10']);
  });

  it('RF-M3-04 si compra y venta no son válidas guarda solo la mediana', async () => {
    const { jobs, rates } = setup();
    rates.configure({ parallel: parallelQuote('11.83', null, null) });

    await jobs.fetchParallel({ force: true });

    const rows = await storedRates();
    expect(rows.map((r) => r.kind)).toEqual(['parallel_median']);
  });

  it('RF-M3-04 una captura más antigua que la guardada del mismo día no la reemplaza', async () => {
    await seed('parallel_median', TODAY, '11.90', ago(1 * MIN, new Date(NOW.getTime() + 10 * MIN)));
    const { jobs } = setup();

    await jobs.fetchParallel({ force: true });

    expect((await storedOf('parallel_median'))[0]?.value).toBe('11.90');
  });
});

describe('fx.fetchParallel: fuente caída', () => {
  it.each(['TIMEOUT', 'SOURCE_ERROR', 'INVALID_VALUE'] as const)(
    'EC-M3-01 si la fuente falla (%s) el último valor queda intacto y el job no lanza',
    async (failure) => {
      const staleAt = ago(61 * MIN);
      await seed('parallel_median', TODAY, '11.50', staleAt);
      const { rates, jobs } = setup();
      rates.configure({ failure });

      await expect(jobs.fetchParallel()).resolves.toBeUndefined();

      const rows = await storedRates();
      expect(rows).toHaveLength(1);
      expect(rows[0]?.value).toBe('11.50');
      expect(rows[0]?.observedAt.getTime()).toBe(staleAt.getTime());
    },
  );

  it('RNF-21 con la fuente caída sin ningún valor guardado no se inventa uno y el lease se libera', async () => {
    const { rates, jobs } = setup();
    rates.configure({ failure: 'SOURCE_ERROR' });

    await expect(jobs.fetchParallel({ force: true })).resolves.toBeUndefined();

    expect(await storedRates()).toHaveLength(0);
    expect((await leaseRow('fx_refresh'))?.lockedUntil).toBeNull();
  });
});

describe('fx.fetchParallel: valores inválidos', () => {
  it.each([
    ['cero', '0'],
    ['negativo', '-11.83'],
    ['menor que 0,01', '0.005'],
    ['con más de 2 decimales', '11.834'],
  ])('EC-M3-04 una mediana %s no se guarda y se conserva el último valor válido', async (_name, bad) => {
    await seed('parallel_median', TODAY, '11.50', ago(61 * MIN));
    const { jobs, rates } = setup();
    rates.configure({ parallel: parallelQuote(bad, '11.81', '11.85') });

    await jobs.fetchParallel();

    const rows = await storedRates();
    expect(rows.map((r) => [r.kind, r.value])).toEqual([['parallel_median', '11.50']]);
  });

  it('EC-M3-04 una compra inválida no se guarda, pero la mediana válida sí', async () => {
    const { jobs, rates } = setup();
    rates.configure({ parallel: parallelQuote('11.83', '0', '11.85') });

    await jobs.fetchParallel({ force: true });

    const rows = await storedRates();
    expect(rows.find((r) => r.kind === 'parallel_median')?.value).toBe('11.83');
    expect(rows.find((r) => r.kind === 'parallel_bid')).toBeUndefined();
  });

  it('EC-M3-04 cualquier valor positivo se acepta, aunque sea un salto grande', async () => {
    await seed('parallel_median', TODAY, '11.50', ago(61 * MIN));
    const { jobs, rates } = setup();
    rates.configure({ parallel: parallelQuote('99.00', '98.50', '99.50') });

    await jobs.fetchParallel();

    expect((await storedOf('parallel_median'))[0]?.value).toBe('99.00');
  });
});

// ---------- fx.fetchOfficial ----------

describe('fx.fetchOfficial', () => {
  it('RF-M3-04 guarda el oficial de paralelo.bo en su fecha de vigencia y no consulta al BCB', async () => {
    const { jobs, rates, bcb } = setup();
    rates.configure({ official: officialQuote('11.69', '2090-03-08') });

    await jobs.fetchOfficial();

    const rows = await storedOf('official');
    expect(rows.map((r) => [r.rateDate, r.value, r.source])).toEqual([
      ['2090-03-08', '11.69', 'paralelo_bo'],
    ]);
    expect(bcb.calls.official).toBe(0);
  });

  it('RF-M3-04 sin fecha de vigencia guarda el oficial en el día de hoy de Bolivia', async () => {
    const { jobs, rates } = setup();
    rates.configure({ official: officialQuote('11.69', null) });

    await jobs.fetchOfficial();

    expect((await storedOf('official')).map((r) => r.rateDate)).toEqual([TODAY]);
  });

  it('RF-M3-04 si paralelo.bo falla para el oficial, usa el BCB y guarda con la fuente bcb', async () => {
    const { jobs, rates, bcb } = setup();
    rates.configure({ failure: 'SOURCE_ERROR' });
    bcb.configure({ official: officialQuote('11.69', '2090-03-08') });

    await jobs.fetchOfficial();

    expect(rates.calls.official).toBe(1);
    expect(bcb.calls.official).toBe(1);
    expect((await storedOf('official')).map((r) => [r.rateDate, r.value, r.source])).toEqual([
      ['2090-03-08', '11.69', 'bcb'],
    ]);
  });

  it('RF-M3-04 ya capturado hoy no vuelve a consultar: corre una vez al día', async () => {
    await seed('official', '2090-03-08', '11.69', ago(2 * 60 * MIN));
    const { jobs, rates, bcb } = setup();
    rates.configure({ official: officialQuote('11.70', '2090-03-10') });

    await jobs.fetchOfficial();

    expect(rates.calls.official).toBe(0);
    expect(bcb.calls.official).toBe(0);
  });

  it('RF-M3-04 con la última captura de ayer sí consulta', async () => {
    await seed('official', '2090-03-08', '11.69', new Date('2090-03-09T15:00:00Z'));
    const { jobs, rates } = setup();
    rates.configure({ official: officialQuote('11.70', '2090-03-10') });

    await jobs.fetchOfficial();

    expect(rates.calls.official).toBe(1);
    expect((await storedOf('official')).map((r) => r.value)).toEqual(['11.69', '11.70']);
  });

  it('RF-M3-04 si fallan las dos fuentes no guarda nada y reintenta en el siguiente tick hasta lograrlo', async () => {
    const { jobs, rates, bcb } = setup();
    rates.configure({ failure: 'TIMEOUT' });
    bcb.configure({ failure: 'SOURCE_ERROR' });

    await expect(jobs.fetchOfficial()).resolves.toBeUndefined();
    expect(await storedOf('official')).toHaveLength(0);

    await jobs.fetchOfficial();
    expect(rates.calls.official).toBe(2);
    expect(bcb.calls.official).toBe(2);

    bcb.configure({ failure: null, official: officialQuote('11.69', '2090-03-08') });
    await jobs.fetchOfficial();
    expect((await storedOf('official')).map((r) => [r.value, r.source])).toEqual([
      ['11.69', 'bcb'],
    ]);
  });

  it('EC-M3-01 / RNF-21 si las dos fuentes fallan, el último oficial guardado queda intacto', async () => {
    const previousAt = new Date('2090-03-09T15:00:00Z');
    await seed('official', '2090-03-08', '11.69', previousAt);
    const { jobs, rates, bcb } = setup();
    rates.configure({ failure: 'SOURCE_ERROR' });
    bcb.configure({ failure: 'SOURCE_ERROR' });

    await jobs.fetchOfficial();

    const rows = await storedOf('official');
    expect(rows).toHaveLength(1);
    expect(rows[0]?.value).toBe('11.69');
    expect(rows[0]?.observedAt.getTime()).toBe(previousAt.getTime());
  });

  it('EC-M3-04 un oficial cero de paralelo.bo no se guarda y se usa el BCB', async () => {
    const { jobs, rates, bcb } = setup();
    rates.configure({ official: officialQuote('0', '2090-03-08') });
    bcb.configure({ official: officialQuote('11.69', '2090-03-08') });

    await jobs.fetchOfficial();

    expect((await storedOf('official')).map((r) => [r.value, r.source])).toEqual([
      ['11.69', 'bcb'],
    ]);
  });

  it('EC-M3-04 si las dos fuentes dan un valor inválido (cero o negativo) no se guarda nada', async () => {
    const { jobs, rates, bcb } = setup();
    rates.configure({ official: officialQuote('0', '2090-03-08') });
    bcb.configure({ official: officialQuote('-6.96', '2090-03-08') });

    await jobs.fetchOfficial();

    expect(await storedOf('official')).toHaveLength(0);
  });
});

// ---------- Una sola actualización a la vez ----------

describe('lease fx_refresh (plan §4.3.3)', () => {
  it('RF-M3-04 con el lease fx_refresh vigente, la actualización no consulta, ni siquiera a pedido', async () => {
    await holdLease('fx_refresh', new Date(NOW.getTime() + 3 * MIN));
    const { jobs, rates } = setup();

    await jobs.fetchParallel({ force: true });

    expect(rates.calls.parallel).toBe(0);
    expect(await storedRates()).toHaveLength(0);
  });

  it('RF-M3-04 con el lease fx_refresh vigente, el oficial tampoco consulta', async () => {
    await holdLease('fx_refresh', new Date(NOW.getTime() + 3 * MIN));
    const { jobs, rates, bcb } = setup();
    rates.configure({ official: officialQuote('11.69', '2090-03-08') });

    await jobs.fetchOfficial();

    expect(rates.calls.official).toBe(0);
    expect(bcb.calls.official).toBe(0);
  });

  it('RNF-13 un lease fx_refresh vencido (la corrida anterior murió) se toma y la actualización corre', async () => {
    await holdLease('fx_refresh', ago(MIN));
    const { jobs, rates } = setup();

    await jobs.fetchParallel({ force: true });

    expect(rates.calls.parallel).toBe(1);
  });

  it('RF-M3-04 mientras corre la actualización tiene el lease y al terminar lo libera', async () => {
    const { jobs, rates } = setup();
    rates.configure({ delayMs: 600 });

    const run = jobs.fetchParallel({ force: true });
    // Wait for the lease instead of sleeping a fixed time: a slow runner takes longer to acquire it.
    let during = await leaseRow('fx_refresh');
    for (let waited = 0; !during?.lockedUntil && waited < 500; waited += 20) {
      await sleep(20);
      during = await leaseRow('fx_refresh');
    }
    await run;

    expect(during?.lockedUntil).not.toBeNull();
    expect((await leaseRow('fx_refresh'))?.lockedUntil).toBeNull();
  });

  it('RF-M3-04 dos actualizaciones a pedido a la vez consultan la fuente una sola vez', async () => {
    const { jobs, rates } = setup();
    rates.configure({ delayMs: 150 });

    await Promise.all([
      jobs.fetchParallel({ force: true }),
      jobs.fetchParallel({ force: true }),
      jobs.fetchParallel({ force: true }),
    ]);

    expect(rates.calls.parallel).toBe(1);
    expect(await storedOf('parallel_median')).toHaveLength(1);
  });

  it('RF-M3-04 la actualización del paralelo y la del oficial a la vez no corren juntas', async () => {
    const { jobs, rates } = setup();
    rates.configure({ delayMs: 150, official: officialQuote('11.69', '2090-03-08') });

    await Promise.all([jobs.fetchParallel({ force: true }), jobs.fetchOfficial()]);

    expect(rates.calls.parallel + rates.calls.official).toBe(1);
  });
});

// ---------- Contenedor ----------

describe('contenedor', () => {
  const envSource = (): Record<string, string> => ({
    NODE_ENV: 'test',
    PORT: '3000',
    DATABASE_URL: testDatabaseUrl(),
    AUTH_SECRET: 'auth-secret-for-the-fx-jobs-test',
    HMAC_SECRET: 'hmac-secret-for-the-fx-jobs-test',
    JOBS_SECRET: 'jobs-secret-for-the-fx-jobs-test',
    RESEND_API_KEY: 'resend-key-for-the-fx-jobs-test',
    RELEASE: '1.0',
    WEB_ORIGIN: 'http://localhost:5173',
    INTEGRATIONS: 'fake',
  });

  it('RF-M3-04 el contenedor registra fx.fetchParallel y fx.fetchOfficial en container.jobs', async () => {
    const container = await Promise.resolve(buildContainer(parseEnv(envSource())));
    try {
      expect(() => {
        container.jobs.registerJob('fx.fetchParallel', () => Promise.resolve());
      }).toThrow();
      expect(() => {
        container.jobs.registerJob('fx.fetchOfficial', () => Promise.resolve());
      }).toThrow();
    } finally {
      await container.prisma.$disconnect();
    }
  });

  it('RNF-21 con INTEGRATIONS=fake y sin cotizaciones el tick corre los dos jobs y la app sigue funcionando', async () => {
    await prisma.$executeRaw`DELETE FROM job_run WHERE job IN ('fx.fetchParallel', 'fx.fetchOfficial')`;
    const container = await Promise.resolve(buildContainer(parseEnv(envSource())));
    try {
      await expect(container.jobs.tick()).resolves.toBeUndefined();

      expect((await leaseRow('fx.fetchParallel'))?.lastStartedAt).not.toBeNull();
      expect((await leaseRow('fx.fetchOfficial'))?.lastStartedAt).not.toBeNull();
    } finally {
      await container.prisma.$disconnect();
      await prisma.$executeRaw`DELETE FROM job_run WHERE job IN ('fx.fetchParallel', 'fx.fetchOfficial')`;
    }
  });
});
