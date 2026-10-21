import {
  DEFAULT_DASHBOARD_BLOCKS,
  MAX_FAVORITE_CATEGORIES,
  type ResetSettingsInput,
} from '@finanzas/contracts';
import { uuidv7 } from 'uuidv7';

import { AppError } from '../errors.js';
import type {
  FavoriteCategoriesChange,
  Repositories,
  UserSettingsChanges,
  UserSettingsData,
} from '../ports/repositories.js';
import type { UnitOfWork } from '../ports/unit-of-work.js';

/** A partial update of the settings; `favoriteCategories` replaces the favorites of its kind. */
export interface SettingsUpdate extends UserSettingsChanges {
  favoriteCategories?: FavoriteCategoriesChange;
}

/** A section of the settings screen that can go back to its defaults (plan §4.9.1). */
export type SettingsSection = ResetSettingsInput['section'];

/** Request context built from the session (plan §1.4). */
export interface SettingsContext {
  userId: string;
  now: Date;
}

export interface SettingsService {
  get(userId: string): Promise<UserSettingsData>;
  /** Partial update; the last write wins (EC-M9-01, RNF-08). */
  update(userId: string, changes: SettingsUpdate): Promise<UserSettingsData>;
  /** Puts one section back to its defaults; it never touches data (RF-M9-05). */
  reset(ctx: SettingsContext, section: SettingsSection): Promise<void>;
}

const USD = 'USD';

/** `currencies`: only the USD reference goes back to the median and the manual value is turned off. */
async function resetCurrencies(repos: Repositories, { userId, now }: SettingsContext): Promise<void> {
  const fx = await repos.userSettings.fxSettings(userId);
  if (fx === null) {
    throw new AppError('SESSION_EXPIRED');
  }
  if (fx.usdReference !== 'parallel_median') {
    await repos.userSettings.updateFx(userId, { usdReference: 'parallel_median' });
    await repos.userFxEvents.insert({
      id: uuidv7(),
      kind: 'reference_set',
      currencyCode: USD,
      reference: 'parallel_median',
      value: null,
      effectiveAt: now,
    });
  }
  if (fx.manualUsdValue !== null) {
    await repos.userSettings.updateFx(userId, { manualUsd: null });
    await repos.userFxEvents.insert({
      id: uuidv7(),
      kind: 'manual_usd_off',
      currencyCode: USD,
      reference: null,
      value: null,
      effectiveAt: now,
    });
  }
}

/** Writes the defaults of one section under the user's lock (plan §4.9.2). */
async function resetSection(
  repos: Repositories,
  ctx: SettingsContext,
  section: SettingsSection,
): Promise<void> {
  const { userId } = ctx;
  switch (section) {
    case 'general':
      await repos.userSettings.update(userId, {
        numberFormat: 'dot_comma',
        dateFormat: 'dmy',
        weekStart: 'monday',
        theme: 'system',
      });
      return;
    case 'currencies':
      await resetCurrencies(repos, ctx);
      return;
    case 'register':
      await repos.userSettings.update(userId, { defaultAccountId: null, alwaysShowNote: false });
      await repos.userSettings.replaceFavorites(userId, { kind: 'expense', ids: [] });
      await repos.userSettings.replaceFavorites(userId, { kind: 'income', ids: [] });
      return;
    case 'dashboard':
      await repos.userSettings.update(userId, {
        dashboardBlocks: DEFAULT_DASHBOARD_BLOCKS.map((block) => ({ ...block })),
      });
      return;
    case 'reminders':
      // The reminder preferences arrive with V1.2; until then they are already their defaults.
      return;
  }
}

/** The default account must be an active account of the user (plan §4.9.2, EC-M9-02). */
async function assertDefaultAccount(repos: Repositories, accountId: string): Promise<void> {
  const account = await repos.accounts.get(accountId);
  if (account === null) {
    throw new AppError('NOT_FOUND');
  }
  if (account.status !== 'active') {
    throw new AppError('ACCOUNT_ARCHIVED');
  }
}

/** Every favorite must be an active category of the user and of the given kind (RF-M7-04). */
async function assertFavorites(
  repos: Repositories,
  { kind, ids }: FavoriteCategoriesChange,
): Promise<void> {
  for (const id of ids) {
    const category = await repos.categories.get(id);
    if (category === null) {
      throw new AppError('CATEGORY_NOT_FOUND');
    }
    if (category.status !== 'active') {
      throw new AppError('CATEGORY_ARCHIVED');
    }
    if (category.kind !== kind) {
      throw new AppError('VALIDATION_ERROR');
    }
  }
}

export function createSettingsService({ uow }: { uow: UnitOfWork }): SettingsService {
  return {
    async get(userId) {
      const settings = await uow.run((repos) => repos.userSettings.find(userId), {
        readOnly: true,
      });
      if (settings === null) {
        throw new AppError('SESSION_EXPIRED');
      }
      return settings;
    },

    async update(userId, changes) {
      const keys = changes.dashboardBlocks?.map((b) => b.key);
      if (keys !== undefined && new Set(keys).size !== keys.length) {
        throw new AppError('VALIDATION_ERROR');
      }
      const { favoriteCategories, ...fields } = changes;
      const favoriteIds = favoriteCategories?.ids;
      if (
        favoriteIds !== undefined &&
        (favoriteIds.length > MAX_FAVORITE_CATEGORIES || new Set(favoriteIds).size !== favoriteIds.length)
      ) {
        throw new AppError('VALIDATION_ERROR');
      }
      const settings = await uow.run(
        async (repos) => {
          if (fields.defaultAccountId !== undefined && fields.defaultAccountId !== null) {
            await assertDefaultAccount(repos, fields.defaultAccountId);
          }
          if (favoriteCategories !== undefined) {
            await assertFavorites(repos, favoriteCategories);
            await repos.userSettings.replaceFavorites(userId, favoriteCategories);
          }
          await repos.userSettings.update(userId, fields);
          return repos.userSettings.find(userId);
        },
        { userLock: userId },
      );
      if (settings === null) {
        throw new AppError('SESSION_EXPIRED');
      }
      return settings;
    },

    async reset(ctx, section) {
      await uow.run(
        async (repos) => {
          if ((await repos.userSettings.find(ctx.userId)) === null) {
            throw new AppError('SESSION_EXPIRED');
          }
          await resetSection(repos, ctx, section);
        },
        { userLock: ctx.userId },
      );
    },
  };
}
