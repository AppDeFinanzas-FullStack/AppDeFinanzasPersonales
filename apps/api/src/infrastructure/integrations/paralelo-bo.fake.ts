import { Decimal } from 'decimal.js';

import type { LocalDate } from '../../application/ports/clock.js';
import type {
  OfficialQuote,
  ParallelQuote,
  RateFailure,
  RateResult,
  RatesGateway,
} from '../../application/ports/rates-gateway.js';

export interface FakeRatesOptions {
  parallel?: ParallelQuote;
  official?: OfficialQuote;
  failure?: RateFailure | null;
  delayMs?: number;
}

export type FakeRatesGateway = RatesGateway & {
  configure(patch: Partial<FakeRatesOptions>): void;
  calls: { parallel: number; official: number; parallelOn: number };
};

export function createFakeRatesGateway(opts: FakeRatesOptions = {}): FakeRatesGateway {
  const state: FakeRatesOptions = { ...opts };
  const calls = { parallel: 0, official: 0, parallelOn: 0 };

  async function respond<T>(produce: () => T | undefined): Promise<RateResult<T>> {
    if (state.delayMs !== undefined && state.delayMs > 0) {
      await new Promise<void>((resolve) => setTimeout(resolve, state.delayMs));
    }
    if (state.failure) return { ok: false, reason: state.failure };
    const value = produce();
    if (value === undefined) return { ok: false, reason: 'SOURCE_ERROR' };
    return { ok: true, value };
  }

  return {
    calls,
    configure(patch) {
      Object.assign(state, patch);
    },
    fetchParallel() {
      calls.parallel += 1;
      return respond(() => state.parallel);
    },
    fetchOfficial() {
      calls.official += 1;
      return respond(() => state.official);
    },
    fetchParallelOn(date: LocalDate) {
      calls.parallelOn += 1;
      return respond(() =>
        state.parallel ? { median: new Decimal(state.parallel.median), date } : undefined,
      );
    },
  };
}
