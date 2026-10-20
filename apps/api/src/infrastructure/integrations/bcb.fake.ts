import type { OfficialQuote, RateFailure, RatesGateway } from '../../application/ports/rates-gateway.js';

export interface FakeBcbOptions {
  official?: OfficialQuote;
  failure?: RateFailure | null;
  delayMs?: number;
}

export type FakeBcbGateway = Pick<RatesGateway, 'fetchOfficial'> & {
  configure(patch: Partial<FakeBcbOptions>): void;
  calls: { official: number };
};

export function createFakeBcbGateway(opts: FakeBcbOptions = {}): FakeBcbGateway {
  const state: FakeBcbOptions = { ...opts };
  const calls = { official: 0 };

  return {
    calls,
    configure(patch) {
      Object.assign(state, patch);
    },
    async fetchOfficial() {
      calls.official += 1;
      if (state.delayMs !== undefined && state.delayMs > 0) {
        await new Promise<void>((resolve) => setTimeout(resolve, state.delayMs));
      }
      if (state.failure) return { ok: false, reason: state.failure };
      if (!state.official) return { ok: false, reason: 'SOURCE_ERROR' };
      return { ok: true, value: state.official };
    },
  };
}
