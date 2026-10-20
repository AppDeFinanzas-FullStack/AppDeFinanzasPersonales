import { pathToFileURL } from 'node:url';
import { PrismaClient } from '@prisma/client';
import { Decimal } from 'decimal.js';

type LocalDate = string;

export interface BackfillClient {
  parallelMedianOn(date: LocalDate): Promise<Decimal | null>;
  officialSeries(): Promise<ReadonlyArray<{ effectiveDate: LocalDate; value: Decimal }>>;
}

export interface BackfillInput {
  db: PrismaClient;
  client: BackfillClient;
  from: LocalDate;
  to: LocalDate;
  now?: () => Date;
  sleep?: (ms: number) => Promise<void>;
}

const BCB_FIRST_DAY: LocalDate = '2026-06-27';
const SEED_OFFICIAL = new Decimal('6.96');
const LA_PAZ_OFFSET_HOURS = 4;
const PARALLEL_DELAY_MS = 1000;
const DAY_MS = 86_400_000;

function parseDay(day: LocalDate): Date {
  return new Date(`${day}T00:00:00Z`);
}

function formatDay(date: Date): LocalDate {
  return date.toISOString().slice(0, 10);
}

function daysBetween(from: LocalDate, to: LocalDate): LocalDate[] {
  const days: LocalDate[] = [];
  const end = parseDay(to).getTime();
  for (let t = parseDay(from).getTime(); t <= end; t += DAY_MS) {
    days.push(formatDay(new Date(t)));
  }
  return days;
}

// Start of the next La Paz day (UTC-4, no daylight saving), capped at now.
function observedAtFor(day: LocalDate, now: Date): Date {
  const nextStart = new Date(parseDay(day).getTime() + DAY_MS + LA_PAZ_OFFSET_HOURS * 3_600_000);
  return nextStart.getTime() < now.getTime() ? nextStart : now;
}

type Kind = 'parallel_median' | 'official';
type Source = 'paralelo_bo' | 'bcb' | 'seed';

async function upsert(
  db: PrismaClient,
  row: { kind: Kind; day: LocalDate; value: Decimal; source: Source; observedAt: Date },
): Promise<void> {
  await db.$executeRaw`
    INSERT INTO market_rate (kind, rate_date, value, observed_at, source)
    VALUES (${row.kind}::market_rate_kind, ${row.day}::date, ${row.value.toFixed(2)}::numeric,
            ${row.observedAt}, ${row.source}::rate_source)
    ON CONFLICT (kind, rate_date) DO UPDATE
      SET value = excluded.value, observed_at = excluded.observed_at, source = excluded.source
      WHERE excluded.observed_at > market_rate.observed_at`;
}

const realSleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

export async function runFxBackfill(input: BackfillInput): Promise<{ parallel: number; official: number }> {
  const { db, client, from, to } = input;
  const now = input.now ?? ((): Date => new Date());
  const sleep = input.sleep ?? realSleep;
  const days = daysBetween(from, to);
  const moment = now();

  let parallel = 0;
  for (const [index, day] of days.entries()) {
    if (index > 0) {
      await sleep(PARALLEL_DELAY_MS);
    }
    const median = await client.parallelMedianOn(day);
    if (median === null) {
      continue;
    }
    await upsert(db, {
      kind: 'parallel_median',
      day,
      value: median,
      source: 'paralelo_bo',
      observedAt: observedAtFor(day, moment),
    });
    parallel += 1;
  }

  const series = [...(await client.officialSeries())].sort((a, b) =>
    a.effectiveDate < b.effectiveDate ? 1 : a.effectiveDate > b.effectiveDate ? -1 : 0,
  );
  let official = 0;
  for (const day of days) {
    let value: Decimal;
    let source: Source;
    if (day < BCB_FIRST_DAY) {
      value = SEED_OFFICIAL;
      source = 'seed';
    } else {
      const entry = series.find((s) => s.effectiveDate <= day);
      if (!entry) {
        continue;
      }
      value = entry.value;
      source = 'bcb';
    }
    await upsert(db, { kind: 'official', day, value, source, observedAt: observedAtFor(day, moment) });
    official += 1;
  }
  return { parallel, official };
}

// ---- Real client (command line only) ----

const PARALELO_URL = 'https://paralelo.bo/mcp';
const BCB_EVOLUTION_URL = 'https://www.bcb.gob.bo/bcb_tco_publico_evolutivo.php';
const MONTHS = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic'];

function cellsOf(row: string): string[] {
  return [...row.matchAll(/<t[hd][^>]*>([\s\S]*?)<\/t[hd]>/gi)].map((m) => (m[1] ?? '').replace(/<[^>]*>/g, '').trim());
}

export function parseBcbEvolution(html: string): Array<{ effectiveDate: LocalDate; value: Decimal }> {
  const title = /Fecha de corte\s*(\d{2})\/(\d{2})\/(\d{4})\D{1,12}?(\d{2})\/(\d{2})\/(\d{4})/i.exec(html);
  if (!title) {
    throw new Error('BCB evolution title not found');
  }
  const startYear = Number(title[3]);
  const endYear = Number(title[6]);
  const endMonth = Number(title[5]);
  const table = /<table[\s\S]*?<\/table>/i.exec(html)?.[0] ?? '';
  const rows = (table.match(/<tr[\s\S]*?<\/tr>/gi) ?? []).map(cellsOf);
  const header = rows.find((c) => c.some((t) => /^\d{1,2}-[a-zñ]{3}/i.test(t)));
  const data = rows.find((c) => /BANCOS \(MEDIANA PONDERADA POR MONTO\)/i.test(c[0] ?? ''));
  if (!header || !data) {
    throw new Error('BCB evolution row not found');
  }
  const offset = header.length - data.length;
  const out: Array<{ effectiveDate: LocalDate; value: Decimal }> = [];
  for (const [i, label] of header.entries()) {
    const match = /^(\d{1,2})-([a-zñ]{3})/i.exec(label);
    const raw = data[i - offset];
    if (!match || raw === undefined) {
      continue;
    }
    const month = MONTHS.indexOf((match[2] ?? '').toLowerCase()) + 1;
    const text = raw.replace(',', '.');
    if (month === 0 || !/^\d+(\.\d+)?$/.test(text)) {
      continue;
    }
    const year = startYear !== endYear && month > endMonth ? startYear : endYear;
    const cut = Date.UTC(year, month - 1, Number(match[1]));
    out.push({ effectiveDate: formatDay(new Date(cut + DAY_MS)), value: new Decimal(text).toDecimalPlaces(2) });
  }
  return out;
}

function createRealClient(): BackfillClient {
  return {
    async parallelMedianOn(date) {
      const response = await fetch(PARALELO_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'tools/call',
          params: { name: 'get_historical_rate', arguments: { date } },
        }),
      });
      if (!response.ok) {
        return null;
      }
      const body = (await response.json()) as {
        result?: { isError?: boolean; structuredContent?: { median?: unknown; illustrative?: unknown } };
      };
      const result = body.result;
      if (!result || result.isError || result.structuredContent?.illustrative === true) {
        return null;
      }
      const median = result.structuredContent?.median;
      if (typeof median !== 'number' || !Number.isFinite(median) || median < 0.01) {
        return null;
      }
      return new Decimal(median.toFixed(2));
    },
    async officialSeries() {
      const response = await fetch(BCB_EVOLUTION_URL);
      if (!response.ok) {
        throw new Error(`BCB responded ${response.status}`);
      }
      return parseBcbEvolution(await response.text());
    },
  };
}

async function main(): Promise<void> {
  const db = new PrismaClient();
  try {
    const today = formatDay(new Date(Date.now() - LA_PAZ_OFFSET_HOURS * 3_600_000));
    const result = await runFxBackfill({ db, client: createRealClient(), from: '2024-01-01', to: today });
    process.stdout.write(`fx-backfill done: ${JSON.stringify(result)}\n`);
  } finally {
    await db.$disconnect();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
