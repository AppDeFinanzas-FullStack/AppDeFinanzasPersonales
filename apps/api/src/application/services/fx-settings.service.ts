import type { Decimal } from 'decimal.js';

import { AppError } from '../errors.js';
import type { IdGenerator } from '../ports/id-generator.js';
import type { MarketRateKind, Repositories, UserFxSettings } from '../ports/repositories.js';
import type { UnitOfWork } from '../ports/unit-of-work.js';

/** Request context built from the session (plan §1.4). */
export interface FxSettingsContext {
  userId: string;
  now: Date;
}

/** The exchange-rate settings the user can change; absent fields stay as they are. */
export interface FxSettingsChanges {
  usdReference?: MarketRateKind;
  baseCurrency?: string;
}

export interface FxSettingsService {
  /**
   * Changes the USD reference and the base currency (RF-M3-11). A new reference is recorded as a
   * `reference_set` event (RF-M3-13); the base must be an active currency (`CURRENCY_INACTIVE`).
   */
  update(ctx: FxSettingsContext, changes: FxSettingsChanges): Promise<void>;
  /** Turns the manual USD value on; it never expires by itself (RF-M3-03, plan §4.3.3). */
  setManual(ctx: FxSettingsContext, value: Decimal): Promise<void>;
  /** Turns the manual USD value off (plan §4.3.3). */
  clearManual(ctx: FxSettingsContext): Promise<void>;
}

const USD = 'USD';

async function settingsOf(repos: Repositories, userId: string): Promise<UserFxSettings> {
  const settings = await repos.userSettings.fxSettings(userId);
  if (settings === null) {
    throw new AppError('SESSION_EXPIRED');
  }
  return settings;
}

/**
 * Exchange-rate settings of the user (plan §4.3.2, §4.3.3). Every change and its event go in one
 * transaction under the user's lock; no recorded movement is rewritten (RF-M3-11).
 */
export function createFxSettingsService({
  uow,
  ids,
}: {
  uow: UnitOfWork;
  ids: IdGenerator;
}): FxSettingsService {
  return {
    async update(ctx, changes) {
      await uow.run(
        async (repos) => {
          const settings = await settingsOf(repos, ctx.userId);
          if (changes.baseCurrency !== undefined) {
            const currency = await repos.currencies.lockForShare(changes.baseCurrency);
            if (currency?.status !== 'active') {
              throw new AppError('CURRENCY_INACTIVE');
            }
          }
          const newReference =
            changes.usdReference !== undefined && changes.usdReference !== settings.usdReference
              ? changes.usdReference
              : undefined;
          await repos.userSettings.updateFx(ctx.userId, {
            ...(changes.baseCurrency === undefined ? {} : { baseCurrency: changes.baseCurrency }),
            ...(newReference === undefined ? {} : { usdReference: newReference }),
          });
          if (newReference !== undefined) {
            await repos.userFxEvents.insert({
              id: ids.next(),
              kind: 'reference_set',
              currencyCode: USD,
              reference: newReference,
              value: null,
              effectiveAt: ctx.now,
            });
          }
        },
        { userLock: ctx.userId },
      );
    },

    async setManual(ctx, value) {
      await uow.run(
        async (repos) => {
          await settingsOf(repos, ctx.userId);
          await repos.userSettings.updateFx(ctx.userId, {
            manualUsd: { value, since: ctx.now },
          });
          await repos.userFxEvents.insert({
            id: ids.next(),
            kind: 'manual_usd_on',
            currencyCode: USD,
            reference: null,
            value,
            effectiveAt: ctx.now,
          });
        },
        { userLock: ctx.userId },
      );
    },

    async clearManual(ctx) {
      await uow.run(
        async (repos) => {
          const settings = await settingsOf(repos, ctx.userId);
          if (settings.manualUsdValue === null) {
            return;
          }
          await repos.userSettings.updateFx(ctx.userId, { manualUsd: null });
          await repos.userFxEvents.insert({
            id: ids.next(),
            kind: 'manual_usd_off',
            currencyCode: USD,
            reference: null,
            value: null,
            effectiveAt: ctx.now,
          });
        },
        { userLock: ctx.userId },
      );
    },
  };
}
