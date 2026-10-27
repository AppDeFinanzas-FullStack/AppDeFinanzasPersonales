import type { Decimal } from 'decimal.js';

import { todayFor } from '../../domain/index.js';
import type { Clock } from '../ports/clock.js';
import type { JobRuns } from '../ports/job-runs.js';
import type { RateSource } from '../ports/repositories.js';
import type { RatesGateway } from '../ports/rates-gateway.js';
import type { UnitOfWork } from '../ports/unit-of-work.js';

const FX_REFRESH_LEASE = 'fx_refresh';
const BOLIVIA_TIMEZONE = 'America/La_Paz';
const PARALLEL_MAX_AGE_MS = 60 * 60_000;
const MIN_RATE = '0.01';

export interface FxJobsDeps {
  rates: RatesGateway;
  bcb: Pick<RatesGateway, 'fetchOfficial'>;
  uow: UnitOfWork;
  jobRuns: JobRuns;
  clock: Clock;
  /** Runs after a new parallel rate is stored, e.g. the goal milestones (plan §4.12.3). */
  afterParallel?: () => Promise<void>;
}

export interface FxJobs {
  /** Runs when the latest capture is older than 60 minutes, or always with `force` (on demand). */
  fetchParallel(opts?: { force?: boolean }): Promise<void>;
  /** Runs once a day; it retries on every tick until a source answers (plan §4.3.2). */
  fetchOfficial(): Promise<void>;
}

/** A valid rate is at least 0.01 and has at most 2 decimals (EC-M3-04). */
const isValidRate = (value: Decimal): boolean =>
  value.isFinite() && value.gte(MIN_RATE) && value.decimalPlaces() <= 2;

export function createFxJobs({
  rates,
  bcb,
  uow,
  jobRuns,
  clock,
  afterParallel,
}: FxJobsDeps): FxJobs {
  /** One refresh at a time through the `fx_refresh` lease; a source failure never throws. */
  const withLease = async (work: () => Promise<void>): Promise<void> => {
    if (!(await jobRuns.tryAcquire(FX_REFRESH_LEASE, clock.now()))) return;
    let failure: string | undefined;
    try {
      await work();
    } catch (error) {
      failure = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
    }
    await jobRuns.finish(FX_REFRESH_LEASE, clock.now(), failure);
  };

  const boliviaDay = (instant: Date): string => todayFor(BOLIVIA_TIMEZONE, instant);

  const refreshParallel = async (force: boolean): Promise<void> => {
    if (!force) {
      const latest = await uow.run((repos) => repos.marketRates.latest('parallel_median'));
      if (
        latest !== null &&
        clock.now().getTime() - latest.observedAt.getTime() <= PARALLEL_MAX_AGE_MS
      ) {
        return;
      }
    }
    const result = await rates.fetchParallel();
    if (!result.ok || !isValidRate(result.value.median)) return;
    const { median, bid, ask, observedAt } = result.value;
    const rateDate = boliviaDay(clock.now());
    const source: RateSource = 'paralelo_bo';
    await uow.run(async (repos) => {
      await repos.marketRates.upsertIfNewer({
        kind: 'parallel_median',
        rateDate,
        value: median,
        observedAt,
        source,
      });
      if (bid !== null && ask !== null && isValidRate(bid) && isValidRate(ask)) {
        await repos.marketRates.upsertIfNewer({
          kind: 'parallel_bid',
          rateDate,
          value: bid,
          observedAt,
          source,
        });
        await repos.marketRates.upsertIfNewer({
          kind: 'parallel_ask',
          rateDate,
          value: ask,
          observedAt,
          source,
        });
      }
    });
    await afterParallel?.();
  };

  const refreshOfficial = async (): Promise<void> => {
    const today = boliviaDay(clock.now());
    const latest = await uow.run((repos) => repos.marketRates.latest('official'));
    if (latest !== null && boliviaDay(latest.observedAt) === today) return;

    let source: RateSource = 'paralelo_bo';
    let result = await rates.fetchOfficial();
    if (!result.ok || !isValidRate(result.value.value)) {
      source = 'bcb';
      result = await bcb.fetchOfficial();
    }
    if (!result.ok || !isValidRate(result.value.value)) return;
    const quote = result.value;
    await uow.run((repos) =>
      repos.marketRates.upsertIfNewer({
        kind: 'official',
        rateDate: quote.effectiveDate ?? today,
        value: quote.value,
        observedAt: quote.observedAt,
        source,
      }),
    );
  };

  return {
    fetchParallel: (opts) => withLease(() => refreshParallel(opts?.force === true)),
    fetchOfficial: () => withLease(refreshOfficial),
  };
}
