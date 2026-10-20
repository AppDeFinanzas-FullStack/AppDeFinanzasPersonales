import { customRateOn, todayFor } from '@finanzas/domain';
import { Decimal } from 'decimal.js';

import { AppError } from '../errors.js';
import type { IdGenerator } from '../ports/id-generator.js';
import type { Repositories } from '../ports/repositories.js';
import type { UnitOfWork } from '../ports/unit-of-work.js';

/** Request context built from the session (plan §1.4). */
export interface CurrenciesContext {
  userId: string;
  timezone: string;
  now: Date;
}

/** An added currency with its rate in force, in Bs per unit (RF-M3-02). */
export interface CurrencyView {
  code: string;
  symbol: string;
  rate: Decimal;
}

export interface NewCurrency {
  code: string;
  symbol: string;
  rate: Decimal;
}

/** The fields of an added currency the user can change; absent fields stay as they are. */
export interface CurrencyChanges {
  symbol?: string;
  rate?: Decimal;
}

export interface CurrenciesService {
  /** The user's added currencies with their rate in force (plan §4.3.2). */
  list(ctx: CurrenciesContext): Promise<CurrencyView[]>;
  /**
   * Adds a currency and records its rate as a `custom_rate` event (RF-M3-02, RF-M3-13). A code
   * the user already has gives `CURRENCY_CODE_TAKEN`; a rate under Bs 0.01, `RATE_BELOW_MINIMUM`.
   */
  create(ctx: CurrenciesContext, currency: NewCurrency): Promise<CurrencyView>;
  /**
   * Changes the symbol or the rate of a currency. Each new rate is a `custom_rate` event
   * (RF-M3-13); BOB and USD have no rate of their own (`SYSTEM_CURRENCY`, RF-M3-01).
   */
  update(ctx: CurrenciesContext, code: string, changes: CurrencyChanges): Promise<void>;
}

/** Lowest rate an added currency may have (RF-M3-02, EC-M3-07). */
const MIN_RATE = new Decimal('0.01');

const checkMinimum = (rate: Decimal): void => {
  if (rate.lt(MIN_RATE)) {
    throw new AppError('RATE_BELOW_MINIMUM');
  }
};

async function insertRate(
  repos: Repositories,
  ids: IdGenerator,
  ctx: CurrenciesContext,
  code: string,
  rate: Decimal,
): Promise<void> {
  await repos.userFxEvents.insert({
    id: ids.next(),
    kind: 'custom_rate',
    currencyCode: code,
    reference: null,
    value: rate,
    effectiveAt: ctx.now,
  });
}

/**
 * Added currencies of the user (plan §4.3.2, §4.3.3). Every write and its `custom_rate` event go
 * in one transaction under the user's lock, so two requests with the same code never both win.
 */
export function createCurrenciesService({
  uow,
  ids,
}: {
  uow: UnitOfWork;
  ids: IdGenerator;
}): CurrenciesService {
  return {
    async list(ctx) {
      return uow.run(
        async (repos) => {
          const currencies = await repos.currencies.list();
          const events = await repos.userFxEvents.eventsUntil(ctx.now);
          const today = todayFor(ctx.timezone, ctx.now);
          const views: CurrencyView[] = [];
          for (const currency of currencies) {
            if (currency.isSystem) {
              continue;
            }
            const rate = customRateOn(events, currency.code, today, ctx.timezone);
            if (rate !== null) {
              views.push({ code: currency.code, symbol: currency.symbol, rate });
            }
          }
          return views;
        },
        { userLock: ctx.userId, readOnly: true },
      );
    },

    async create(ctx, currency) {
      checkMinimum(currency.rate);
      await uow.run(
        async (repos) => {
          if ((await repos.currencies.get(currency.code)) !== null) {
            throw new AppError('CURRENCY_CODE_TAKEN');
          }
          await repos.currencies.insert({ code: currency.code, symbol: currency.symbol });
          await insertRate(repos, ids, ctx, currency.code, currency.rate);
        },
        { userLock: ctx.userId },
      );
      return { code: currency.code, symbol: currency.symbol, rate: currency.rate };
    },

    async update(ctx, code, changes) {
      if (changes.rate !== undefined) {
        checkMinimum(changes.rate);
      }
      await uow.run(
        async (repos) => {
          const currency = await repos.currencies.lockForUpdate(code);
          if (currency === null) {
            throw new AppError('NOT_FOUND');
          }
          if (changes.rate !== undefined && currency.isSystem) {
            throw new AppError('SYSTEM_CURRENCY');
          }
          if (changes.symbol !== undefined && changes.symbol !== currency.symbol) {
            await repos.currencies.updateSymbol(code, changes.symbol);
          }
          if (changes.rate !== undefined) {
            await insertRate(repos, ids, ctx, code, changes.rate);
          }
        },
        { userLock: ctx.userId },
      );
    },
  };
}
