import type { DashboardBlockKey, SettingsDto } from '@finanzas/contracts';

import type { UserSettingsData } from '../../application/ports/repositories.js';

/** Builds the `SettingsDto` of the contracts (plan §4.9.2). */
export const SettingsPresenter = {
  toDto(settings: UserSettingsData): SettingsDto {
    return {
      numberFormat: settings.numberFormat,
      dateFormat: settings.dateFormat,
      weekStart: settings.weekStart,
      theme: settings.theme,
      sidebarCollapsed: settings.sidebarCollapsed,
      defaultAccountId: settings.defaultAccountId,
      alwaysShowNote: settings.alwaysShowNote,
      dashboardBlocks: settings.dashboardBlocks.map((b) => ({
        key: b.key as DashboardBlockKey,
        visible: b.visible,
      })),
      favorites: settings.favorites,
    };
  },
};
