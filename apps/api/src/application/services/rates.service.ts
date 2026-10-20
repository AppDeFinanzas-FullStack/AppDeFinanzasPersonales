import type { RatesCurrentDto } from '@finanzas/contracts';
import {
  customRateOn,
  gap,
  resolveUsdRate,
  todayFor,
  transferPrefill,
  type FxEvent,
  type LocalDate,
  type MarketSeries,
  type UsdReference,
} from '@finanzas/domain';
import { Decimal } from 'decimal.js';

import { AppError } from '../errors.js';
import type { MarketRateRow, Repositories, UserFxSettings } from '../ports/repositories.js';
import type { UnitOfWork } from '../ports/unit-of-work.js';

/** Request context built from the session (plan §1.4). */
export interface RatesContext {
  userId: string;
  timezone: string;
  now: Date;
  traceId: string;
}

/** Rates a movement stores when it is saved (RN-04, RF-M3-06). */
export interface MovementRates {
  rateCurBob: Decimal;
  /** `null` when there is no USD rate at all (EC-M3-02). */
  rateUsdBob: Decimal | null;
}

export interface RatesService {
  /** Current references, the rate in use and the gap (RF-M3-03, RF-M3-05, RF-M3-12). */
  current(ctx: RatesContext): Promise<RatesCurrentDto>;
  /** Current Bs per unit of the currency, for current balances (RN-05); `null` without a rate. */
  currentRateFor(ctx: RatesContext, currencyCode: string): Promise<Decimal | null>;
  /**
   * Rates of a movement of that currency and date, inside the caller's transaction (RN-04).
   * Throws `RATE_REQUIRED` when a non-BOB movement has no rate (EC-M3-02).
   */
  ratesForMovement(
    repos: Repositories,
    ctx: RatesContext,
    currencyCode: string,
    date: LocalDate,
  ): Promise<MovementRates>;
  /**
   * Declared rate a transfer from `from` to `to` on `date` starts with (RF-M3-07), inside the
   * caller's transaction, with the convention of plan §4.6.1; `null` when a rate is missing.
   */
  transferRate(
    repos: Repositories,
    ctx: RatesContext,
    from: string,
    to: string,
    date: LocalDate,
  ): Promise<Decimal | null>;
}

const KINDS: readonly UsdReference[] = [
  'parallel_bid',
  'parallel_ask',
  'parallel_median',
  'official',
];
const FIRST_DATE: LocalDate = '0001-01-01';
const ONE = new Decimal(1);

type LatestRates = Record<UsdReference, MarketRateRow | null>;

async function latestRates(repos: Repositories): Promise<LatestRates> {
  return {
    parallel_bid: await repos.marketRates.latest('parallel_bid'),
    parallel_ask: await repos.marketRates.latest('parallel_ask'),
    parallel_median: await repos.marketRates.latest('parallel_median'),
    official: await repos.marketRates.latest('official'),
  };
}

/** Rows of one kind that decide its value on `date`: the last one up to it, else the first known. */
async function rowsForDay(
  repos: Repositories,
  kind: UsdReference,
  latest: MarketRateRow | null,
  date: LocalDate,
): Promise<MarketRateRow[]> {
  if (latest === null) {
    return [];
  }
  if (latest.rateDate <= date) {
    return [latest];
  }
  const upTo = await repos.marketRates.series(kind, FIRST_DATE, date);
  if (upTo.length > 0) {
    return upTo.slice(-1);
  }
  const after = await repos.marketRates.series(kind, date, latest.rateDate);
  return after.slice(0, 1);
}

async function seriesFor(
  repos: Repositories,
  latest: LatestRates,
  date: LocalDate,
): Promise<MarketSeries> {
  const series: MarketSeries = {
    parallel_bid: [],
    parallel_ask: [],
    parallel_median: [],
    official: [],
  };
  for (const kind of KINDS) {
    const rows = await rowsForDay(repos, kind, latest[kind], date);
    series[kind] = rows.map((row) => ({ rateDate: row.rateDate, value: row.value }));
  }
  return series;
}

async function usdRateOn(
  repos: Repositories,
  ctx: RatesContext,
  events: FxEvent[],
  latest: LatestRates,
  date: LocalDate,
): Promise<Decimal | null> {
  const series = await seriesFor(repos, latest, date);
  return resolveUsdRate({ events, series, date, tz: ctx.timezone, now: ctx.now });
}

const NO_SERIES: MarketSeries = {
  parallel_bid: [],
  parallel_ask: [],
  parallel_median: [],
  official: [],
};

/** The manual USD value active on `date`, or `null`: without market series only it can resolve. */
function manualUsdOn(ctx: RatesContext, events: FxEvent[], date: LocalDate): Decimal | null {
  const manualEvents = events.filter(
    (event) => event.kind === 'manual_usd_on' || event.kind === 'manual_usd_off',
  );
  return resolveUsdRate({
    events: manualEvents,
    series: NO_SERIES,
    date,
    tz: ctx.timezone,
    now: ctx.now,
  });
}

/** The value of one reference on `date`, resolved as if the user had always chosen it (RF-M3-06). */
function referenceOn(
  ctx: RatesContext,
  series: MarketSeries,
  reference: UsdReference,
  date: LocalDate,
): Decimal | null {
  const chosen: FxEvent = {
    kind: 'reference_set',
    currencyCode: null,
    reference,
    value: null,
    effectiveAt: new Date(0),
  };
  return resolveUsdRate({ events: [chosen], series, date, tz: ctx.timezone, now: ctx.now });
}

/** Parallel bid (compra) and ask (venta) of `date`, or `null` when there is none (RF-M3-07). */
async function parallelOn(
  repos: Repositories,
  ctx: RatesContext,
  date: LocalDate,
): Promise<{ bid: Decimal; ask: Decimal } | null> {
  const series = await seriesFor(repos, await latestRates(repos), date);
  const bid = referenceOn(ctx, series, 'parallel_bid', date);
  const ask = referenceOn(ctx, series, 'parallel_ask', date);
  return bid === null || ask === null ? null : { bid, ask };
}

/** Bs per unit of the currency on `date` (RN-04): 1 for BOB, the USD rate, or the added currency's rate. */
async function rateOn(
  ctx: RatesContext,
  events: FxEvent[],
  usdRate: () => Promise<Decimal | null>,
  currencyCode: string,
  date: LocalDate,
): Promise<Decimal | null> {
  if (currencyCode === 'BOB') {
    return ONE;
  }
  if (currencyCode === 'USD') {
    return usdRate();
  }
  return customRateOn(events, currencyCode, date, ctx.timezone);
}

/** The other one of BOB and USD; BOB when the base is any other currency (glossary). */
function otherCurrency(base: string): string {
  return base === 'BOB' ? 'USD' : 'BOB';
}

function inUseOf(settings: UserFxSettings, value: Decimal | null): RatesCurrentDto['inUse'] {
  if (settings.manualUsdValue !== null) {
    return {
      kind: 'manual',
      value: settings.manualUsdValue.toFixed(2),
      ...(settings.manualUsdSince === null ? {} : { since: settings.manualUsdSince.toISOString() }),
    };
  }
  return { kind: settings.usdReference, value: value === null ? null : value.toFixed(2) };
}

/** Gap of the rate in use against the official one; the median when the official is in use (RF-M3-12). */
function gapOf(inUse: RatesCurrentDto['inUse'], latest: LatestRates): RatesCurrentDto['gap'] {
  const official = latest.official?.value ?? null;
  if (official === null || official.isZero()) {
    return null;
  }
  const comparedKind = inUse.kind === 'official' ? 'parallel_median' : inUse.kind;
  const compared =
    inUse.kind === 'official'
      ? (latest.parallel_median?.value ?? null)
      : inUse.value === null
        ? null
        : new Decimal(inUse.value);
  if (compared === null) {
    return null;
  }
  const result = gap(compared, official);
  return { pct: result.pct.toFixed(2), bs: result.bs.toFixed(2), comparedKind };
}

function referencesOf(latest: LatestRates): RatesCurrentDto['references'] {
  const reference = (row: MarketRateRow | null) =>
    row === null
      ? null
      : {
          value: row.value.toFixed(2),
          observedAt: row.observedAt.toISOString(),
          source: row.source,
        };
  return {
    parallel_bid: reference(latest.parallel_bid),
    parallel_ask: reference(latest.parallel_ask),
    parallel_median: reference(latest.parallel_median),
    official: reference(latest.official),
  };
}

export function createRatesService({ uow }: { uow: UnitOfWork }): RatesService {
  return {
    async current(ctx) {
      return uow.run(
        async (repos) => {
          const settings = await repos.userSettings.fxSettings(ctx.userId);
          if (settings === null) {
            throw new AppError('SESSION_EXPIRED');
          }
          const latest = await latestRates(repos);
          const events = await repos.userFxEvents.eventsUntil(ctx.now);
          const today = todayFor(ctx.timezone, ctx.now);
          const usd = await usdRateOn(repos, ctx, events, latest, today);
          const inUse = inUseOf(settings, usd);
          return {
            references: referencesOf(latest),
            inUse,
            gap: gapOf(inUse, latest),
            base: settings.baseCurrency,
            other: otherCurrency(settings.baseCurrency),
          };
        },
        { userLock: ctx.userId, readOnly: true },
      );
    },

    async currentRateFor(ctx, currencyCode) {
      if (currencyCode === 'BOB') {
        return ONE;
      }
      return uow.run(
        async (repos) => {
          const events = await repos.userFxEvents.eventsUntil(ctx.now);
          const today = todayFor(ctx.timezone, ctx.now);
          const usdRate = async () =>
            usdRateOn(repos, ctx, events, await latestRates(repos), today);
          return rateOn(ctx, events, usdRate, currencyCode, today);
        },
        { userLock: ctx.userId, readOnly: true },
      );
    },

    async ratesForMovement(repos, ctx, currencyCode, date) {
      const events = await repos.userFxEvents.eventsUntil(ctx.now);
      const latest = await latestRates(repos);
      const rateUsdBob = await usdRateOn(repos, ctx, events, latest, date);
      if (rateUsdBob === null && currencyCode !== 'BOB') {
        throw new AppError('RATE_REQUIRED');
      }
      const usdRate = () => Promise.resolve(rateUsdBob);
      const rateCurBob = await rateOn(ctx, events, usdRate, currencyCode, date);
      if (rateCurBob === null) {
        throw new AppError('RATE_REQUIRED');
      }
      return { rateCurBob, rateUsdBob };
    },

    async transferRate(repos, ctx, from, to, date) {
      const events = await repos.userFxEvents.eventsUntil(ctx.now);
      const manual = manualUsdOn(ctx, events, date);
      const usesUsd = from === 'USD' || to === 'USD';
      const parallel = usesUsd && manual === null ? await parallelOn(repos, ctx, date) : null;
      const customRates: Record<string, Decimal> = {};
      for (const code of [from, to]) {
        if (code === 'BOB' || code === 'USD') {
          continue;
        }
        const rate = customRateOn(events, code, date, ctx.timezone);
        if (rate !== null) {
          customRates[code] = rate;
        }
      }
      return transferPrefill({ from, to, date, manual, parallel, customRates });
    },
  };
}
