import { AppError } from '../errors.js';
import type { UserSettingsChanges, UserSettingsData } from '../ports/repositories.js';
import type { UnitOfWork } from '../ports/unit-of-work.js';

export interface SettingsService {
  get(userId: string): Promise<UserSettingsData>;
  /** Partial update; the last write wins (EC-M9-01, RNF-08). */
  update(userId: string, changes: UserSettingsChanges): Promise<UserSettingsData>;
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
      const settings = await uow.run(
        async (repos) => {
          await repos.userSettings.update(userId, changes);
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
