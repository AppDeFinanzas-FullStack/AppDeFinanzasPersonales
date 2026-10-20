import { PRESET_CATEGORIES, type PresetCategory } from '@finanzas/db/seed/preset-categories.js';
import { uuidv7 } from 'uuidv7';

import type {
  DashboardBlock,
  NewCategory,
  NewNotificationPreference,
  Repositories,
} from '../ports/repositories.js';

/** Blocks 3 to 8 of the Home, in the order of spec §2.8.1. */
const DASHBOARD_BLOCK_KEYS = ['budget', 'byCategory', 'pace', 'upcoming', 'balances', 'recent'];

const EVERY_DAY = [0, 1, 2, 3, 4, 5, 6];

/** Default notification preferences (RF-M15-02, plan §4.15.1). */
const DEFAULT_PREFERENCES: NewNotificationPreference[] = [
  { type: 'payment_upcoming', enabled: true, hour: null, leadDays: null, weekdays: null },
  { type: 'budget_alert', enabled: true, hour: null, leadDays: null, weekdays: null },
  { type: 'period_close', enabled: true, hour: null, leadDays: null, weekdays: null },
  { type: 'recurring_pending', enabled: true, hour: null, leadDays: null, weekdays: null },
  { type: 'log_day', enabled: false, hour: 21, leadDays: null, weekdays: EVERY_DAY },
  { type: 'goal_progress', enabled: false, hour: null, leadDays: null, weekdays: null },
];

/** Flattens the preset tree, each parent before its children. */
function buildCategories(userId: string, presets: readonly PresetCategory[]): NewCategory[] {
  const rows: NewCategory[] = [];
  const add = (preset: PresetCategory, parentId: string | null): void => {
    const id = uuidv7();
    rows.push({
      id,
      userId,
      kind: preset.kind,
      parentId,
      name: preset.name,
      color: preset.color,
      icon: preset.icon,
      systemKey: preset.systemKey ?? null,
      seedOrder: preset.seedOrder,
      sortOrder: rows.length,
    });
    for (const child of preset.children ?? []) {
      add(child, id);
    }
  };
  for (const preset of presets) {
    add(preset, null);
  }
  return rows;
}

/**
 * Gives a new user its initial rows, inside the transaction of the registration: the system
 * currencies, the settings, the preset and system categories and the default notification
 * preferences (plan §4.5.3, §4.15.1).
 */
export async function bootstrapUser(
  repos: Pick<Repositories, 'users'>,
  userId: string,
): Promise<void> {
  const blocks: DashboardBlock[] = DASHBOARD_BLOCK_KEYS.map((key) => ({ key, visible: true }));
  await repos.users.createSystemCurrencies(userId);
  await repos.users.createSettings(userId, blocks);
  await repos.users.createCategories(buildCategories(userId, PRESET_CATEGORIES));
  await repos.users.createNotificationPreferences(userId, DEFAULT_PREFERENCES);
}
