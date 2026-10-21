import { MAX_FAVORITE_CATEGORIES } from '@finanzas/contracts';

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

export interface SettingsService {
  get(userId: string): Promise<UserSettingsData>;
  /** Partial update; the last write wins (EC-M9-01, RNF-08). */
  update(userId: string, changes: SettingsUpdate): Promise<UserSettingsData>;
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
  };
}
