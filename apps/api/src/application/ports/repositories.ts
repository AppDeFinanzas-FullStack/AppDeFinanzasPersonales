import type { Decimal } from 'decimal.js';

import type { LocalDate } from './clock.js';

/**
 * Repositories bound to a transaction and to a user (ADR-05).
 * Each module adds its own repository here.
 */
export interface Repositories {
  marketRates: MarketRateRepository;
  currencies: CurrencyRepository;
  userFxEvents: UserFxEventRepository;
}

// ---------- Monedas y tipo de cambio (M3) ----------

export type MarketRateKind = 'parallel_bid' | 'parallel_ask' | 'parallel_median' | 'official';
export type RateSource = 'paralelo_bo' | 'bcb' | 'seed';
export type CurrencyStatus = 'active' | 'inactive';
export type FxEventKind = 'reference_set' | 'manual_usd_on' | 'manual_usd_off' | 'custom_rate';

export interface MarketRateRow {
  kind: MarketRateKind;
  rateDate: LocalDate;
  value: Decimal;
  observedAt: Date;
  source: RateSource;
}

/** Global market data (ADR-12): not bound to any user. */
export interface MarketRateRepository {
  /** Stores the day's rate unless a rate observed at the same instant or later is already there. */
  upsertIfNewer(rate: MarketRateRow): Promise<void>;
  /** Row of the most recent day of that kind, or null. */
  latest(kind: MarketRateKind): Promise<MarketRateRow | null>;
  /** Days of the range, both ends included, in ascending order. */
  series(kind: MarketRateKind, from: LocalDate, to: LocalDate): Promise<MarketRateRow[]>;
}

export interface CurrencyRow {
  code: string;
  symbol: string;
  isSystem: boolean;
  status: CurrencyStatus;
  createdAt: Date;
}

/** Currencies of the user bound to the transaction (RN-09). */
export interface CurrencyRepository {
  list(): Promise<CurrencyRow[]>;
  get(code: string): Promise<CurrencyRow | null>;
  lockForUpdate(code: string): Promise<CurrencyRow | null>;
  lockForShare(code: string): Promise<CurrencyRow | null>;
  insert(currency: { code: string; symbol: string }): Promise<void>;
}

export interface UserFxEventRow {
  id: string;
  kind: FxEventKind;
  currencyCode: string | null;
  reference: MarketRateKind | null;
  value: Decimal | null;
  effectiveAt: Date;
}

/** Exchange-rate events of the user bound to the transaction (RN-09). */
export interface UserFxEventRepository {
  insert(event: UserFxEventRow): Promise<void>;
  /** Events effective at or before the instant, in ascending order. */
  eventsUntil(instant: Date): Promise<UserFxEventRow[]>;
}
