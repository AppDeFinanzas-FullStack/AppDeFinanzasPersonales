import { PrismaClient } from '@prisma/client';
import { Decimal } from 'decimal.js';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { runFxBackfill } from '../scripts/fx-backfill.js';
import { closeSql, sql } from './helpers.js';

const url = process.env['TEST_DATABASE_URL'];
if (!url) {
  throw new Error('TEST_DATABASE_URL is not set');
}
const prisma = new PrismaClient({ datasourceUrl: url });

// Ten days that straddle 2026-06-27, the first day the BCB publishes a TCO.
const FROM = '2026-06-22';
const TO = '2026-07-01';
const DAYS = [
  '2026-06-22',
  '2026-06-23',
  '2026-06-24',
  '2026-06-25',
  '2026-06-26',
  '2026-06-27',
  '2026-06-28',
  '2026-06-29',
  '2026-06-30',
  '2026-07-01',
];
const NOW = new Date('2026-08-01T12:00:00Z');

interface Row {
  kind: string;
  day: string;
  value: string;
  source: string;
  observed_at: Date;
}

async function rows(kind: string): Promise<Row[]> {
  const { rows: r } = await sql().query<Row>(
    `SELECT kind::text AS kind, to_char(rate_date, 'YYYY-MM-DD') AS day, value::text AS value,
            source::text AS source, observed_at
       FROM market_rate WHERE kind = $1::market_rate_kind AND rate_date BETWEEN $2::date AND $3::date
      ORDER BY rate_date`,
    [kind, FROM, TO],
  );
  return r;
}

async function clean(): Promise<void> {
  await sql().query(
    `DELETE FROM market_rate WHERE kind IN ('parallel_median', 'official') AND rate_date BETWEEN $1::date AND $2::date`,
    [FROM, TO],
  );
}

beforeEach(clean);

afterAll(async () => {
  await clean();
  await prisma.$disconnect();
  await closeSql();
});

type Series = ReadonlyArray<{ effectiveDate: string; value: Decimal }>;

function fakeClient(opts: { series?: Series; missing?: string[] } = {}) {
  const calls: string[] = [];
  return {
    calls,
    parallelMedianOn: (date: string): Promise<Decimal | null> => {
      calls.push(date);
      if (opts.missing?.includes(date)) {
        return Promise.resolve(null);
      }
      const n = Number(date.slice(8, 10)) + (date.startsWith('2026-07') ? 30 : 0);
      return Promise.resolve(new Decimal(`9.${String(n).padStart(2, '0')}`));
    },
    officialSeries: (): Promise<Series> =>
      Promise.resolve(
        opts.series ?? [
          { effectiveDate: '2026-06-30', value: new Decimal('10.00') },
          { effectiveDate: '2026-06-27', value: new Decimal('9.50') },
        ],
      ),
  };
}

function run(client: ReturnType<typeof fakeClient>, sleep = vi.fn(() => Promise.resolve())) {
  return runFxBackfill({ db: prisma, client, from: FROM, to: TO, now: () => NOW, sleep });
}

describe('TASK-091 fx-backfill with a 10-day client', () => {
  it('TASK-091 inserts 10 parallel medians, one per day, from paralelo_bo', async () => {
    const client = fakeClient();
    const result = await run(client);
    const medians = await rows('parallel_median');
    expect(medians.map((m) => m.day)).toEqual(DAYS);
    expect(medians.every((m) => m.source === 'paralelo_bo')).toBe(true);
    expect(medians[0]!.value).toBe('9.22');
    expect(medians[9]!.value).toBe('9.31');
    expect(client.calls).toEqual(DAYS);
    expect(result).toEqual({ parallel: 10, official: 10 });
  });

  it('TASK-091 the official rate is 6.96 (seed) up to 2026-06-26', async () => {
    await run(fakeClient());
    const before = (await rows('official')).filter((r) => r.day <= '2026-06-26');
    expect(before.map((r) => r.day)).toEqual(DAYS.slice(0, 5));
    expect(before.every((r) => r.value === '6.96' && r.source === 'seed')).toBe(true);
  });

  it('TASK-091 from 2026-06-27 the official rate is the latest series value effective on or before the day (bcb)', async () => {
    await run(fakeClient());
    const after = (await rows('official')).filter((r) => r.day >= '2026-06-27');
    expect(after.map((r) => [r.day, r.value, r.source])).toEqual([
      ['2026-06-27', '9.50', 'bcb'],
      ['2026-06-28', '9.50', 'bcb'],
      ['2026-06-29', '9.50', 'bcb'],
      ['2026-06-30', '10.00', 'bcb'],
      ['2026-07-01', '10.00', 'bcb'],
    ]);
  });

  it('TASK-091 a day with no earlier series entry is skipped', async () => {
    const client = fakeClient({ series: [{ effectiveDate: '2026-06-29', value: new Decimal('9.80') }] });
    const result = await run(client);
    const after = (await rows('official')).filter((r) => r.day >= '2026-06-27');
    expect(after.map((r) => [r.day, r.value])).toEqual([
      ['2026-06-29', '9.80'],
      ['2026-06-30', '9.80'],
      ['2026-07-01', '9.80'],
    ]);
    expect(result.official).toBe(8);
  });

  it('TASK-091 a day where the source has no data (null) is skipped', async () => {
    const result = await run(fakeClient({ missing: ['2026-06-24'] }));
    const medians = await rows('parallel_median');
    expect(medians).toHaveLength(9);
    expect(medians.map((m) => m.day)).not.toContain('2026-06-24');
    expect(result.parallel).toBe(9);
  });

  it('TASK-091 running it twice does not duplicate anything', async () => {
    await run(fakeClient());
    const firstMedians = await rows('parallel_median');
    const firstOfficial = await rows('official');
    await run(fakeClient());
    expect(await rows('parallel_median')).toEqual(firstMedians);
    expect(await rows('official')).toEqual(firstOfficial);
    expect(firstMedians).toHaveLength(10);
    expect(firstOfficial).toHaveLength(10);
  });

  it('TASK-091 observed_at is the start of the next La Paz day when that is before now()', async () => {
    await run(fakeClient());
    const medians = await rows('parallel_median');
    // 2026-06-22 ends at 2026-06-23T00:00-04:00 = 04:00Z.
    expect(medians[0]!.observed_at.toISOString()).toBe('2026-06-23T04:00:00.000Z');
    expect(medians[9]!.observed_at.toISOString()).toBe('2026-07-02T04:00:00.000Z');
    const official = await rows('official');
    expect(official[0]!.observed_at.toISOString()).toBe('2026-06-23T04:00:00.000Z');
  });

  it('TASK-091 observed_at never goes past now()', async () => {
    const now = new Date('2026-06-24T10:00:00Z');
    await runFxBackfill({
      db: prisma,
      client: fakeClient(),
      from: FROM,
      to: TO,
      now: () => now,
      sleep: () => Promise.resolve(),
    });
    const medians = await rows('parallel_median');
    for (const m of medians) {
      expect(m.observed_at.getTime()).toBeLessThanOrEqual(now.getTime());
    }
    expect(medians[0]!.observed_at.toISOString()).toBe('2026-06-23T04:00:00.000Z');
    expect(medians[9]!.observed_at.toISOString()).toBe(now.toISOString());
  });

  it('TASK-091 does not overwrite a row that a job wrote with a newer observed_at', async () => {
    await sql().query(
      `INSERT INTO market_rate (kind, rate_date, value, observed_at, source)
       VALUES ('parallel_median', '2026-06-25', '12.34', '2026-06-26T15:00:00Z', 'paralelo_bo')`,
    );
    await run(fakeClient());
    const row = (await rows('parallel_median')).find((r) => r.day === '2026-06-25')!;
    expect(row.value).toBe('12.34');
    expect(row.observed_at.toISOString()).toBe('2026-06-26T15:00:00.000Z');
  });

  it('TASK-091 replaces a row that has an older observed_at', async () => {
    await sql().query(
      `INSERT INTO market_rate (kind, rate_date, value, observed_at, source)
       VALUES ('parallel_median', '2026-06-25', '12.34', '2026-06-25T10:00:00Z', 'paralelo_bo')`,
    );
    await run(fakeClient());
    const row = (await rows('parallel_median')).find((r) => r.day === '2026-06-25')!;
    expect(row.value).toBe('9.25');
    expect(row.observed_at.toISOString()).toBe('2026-06-26T04:00:00.000Z');
  });

  it('TASK-091 waits with sleep(1000) between parallel queries', async () => {
    const sleep = vi.fn(() => Promise.resolve());
    await run(fakeClient(), sleep);
    expect(sleep.mock.calls.length).toBeGreaterThanOrEqual(9);
    expect(sleep.mock.calls.length).toBeLessThanOrEqual(10);
    expect(sleep.mock.calls.every((c) => (c as unknown[])[0] === 1000)).toBe(true);
  });
});
