// `@finanzas/db` declares no `exports` map, so its files are imported by path.
import { PRESET_CATEGORIES, type PresetCategory } from '@finanzas/db/seed/preset-categories.js';
import { uuidv7 } from 'uuidv7';

import { testPrisma } from '../integration/setup/db.js';

export interface TestUser {
  id: string;
  email: string;
  name: string;
  timezone: string;
}

export interface CreateUserOptions {
  name?: string;
  timezone?: string;
}

/** Dashboard blocks 3 to 8 in the default order of spec §2.8.1, all visible (plan §4.9). */
const DASHBOARD_BLOCKS = ['budget', 'byCategory', 'pace', 'upcoming', 'balances', 'recent'].map(
  (key) => ({ key, visible: true }),
);

const EVERY_DAY = [0, 1, 2, 3, 4, 5, 6];

/** Default notification preferences (plan §4.15.1, RF-M15-02). */
const NOTIFICATION_PREFERENCES: {
  type: string;
  enabled: boolean;
  hour: number | null;
  weekdays: number[] | null;
}[] = [
  { type: 'payment_upcoming', enabled: true, hour: null, weekdays: null },
  { type: 'budget_alert', enabled: true, hour: null, weekdays: null },
  { type: 'period_close', enabled: true, hour: null, weekdays: null },
  { type: 'recurring_pending', enabled: true, hour: null, weekdays: null },
  { type: 'log_day', enabled: false, hour: 21, weekdays: EVERY_DAY },
  { type: 'goal_progress', enabled: false, hour: null, weekdays: null },
];

interface CategoryRow {
  id: string;
  parentId: string | null;
  preset: PresetCategory;
}

/** Preset and system categories (plan §4.5.3), parents before their children. */
function categoryRows(): CategoryRow[] {
  const roots = PRESET_CATEGORIES.map((preset) => ({ id: uuidv7(), parentId: null, preset }));
  const children = roots.flatMap((root) =>
    (root.preset.children ?? []).map((preset) => ({ id: uuidv7(), parentId: root.id, preset })),
  );
  return [...roots, ...children];
}

const createdUserIds: string[] = [];

/**
 * Creates a confirmed user with the initial rows of a new user, by SQL and in one transaction:
 * the system currencies BOB and USD (RF-M3-01), `user_settings` with its defaults, the preset and
 * system categories and the default notification preferences. Each test uses a new user
 * (plan §5.1). From TASK-053 on it uses `user-bootstrap`.
 */
export async function createUser(options: CreateUserOptions = {}): Promise<TestUser> {
  const id = uuidv7();
  const user: TestUser = {
    id,
    email: `${id}@test.local`,
    name: options.name ?? 'Usuario de prueba',
    timezone: options.timezone ?? 'America/La_Paz',
  };
  const db = testPrisma();

  await db.$transaction([
    db.$executeRaw`
      INSERT INTO auth_user (id, name, email, email_verified, timezone, terms_accepted_at, registered_at)
      VALUES (${user.id}::uuid, ${user.name}, ${user.email}, true, ${user.timezone}, now(), now())`,
    db.$executeRaw`
      INSERT INTO currency (user_id, code, symbol, is_system, status)
      VALUES (${user.id}::uuid, 'BOB', 'Bs', true, 'active'),
             (${user.id}::uuid, 'USD', '$', true, 'active')`,
    db.$executeRaw`
      INSERT INTO user_settings (user_id, dashboard_blocks)
      VALUES (${user.id}::uuid, ${JSON.stringify(DASHBOARD_BLOCKS)}::jsonb)`,
    ...categoryRows().map(
      ({ id: categoryId, parentId, preset }) => db.$executeRaw`
        INSERT INTO category
          (id, user_id, kind, parent_id, name, color, icon, is_system, system_key, seed_order, sort_order)
        VALUES (${categoryId}::uuid, ${user.id}::uuid, ${preset.kind}::category_kind,
                ${parentId}::uuid, ${preset.name}, ${preset.color}, ${preset.icon},
                ${preset.systemKey !== undefined}, ${preset.systemKey ?? null}::system_category_key,
                ${preset.seedOrder}::smallint, ${preset.seedOrder}::integer)`,
    ),
    ...NOTIFICATION_PREFERENCES.map(
      (preference) => db.$executeRaw`
        INSERT INTO notification_preference (user_id, type, enabled, hour, weekdays)
        VALUES (${user.id}::uuid, ${preference.type}::notification_type, ${preference.enabled},
                ${preference.hour}::smallint, ${preference.weekdays}::smallint[])`,
    ),
  ]);

  createdUserIds.push(user.id);
  return user;
}

/** Deletes every user created by this file; their rows go with them by cascade (plan §3.8). */
export async function deleteCreatedUsers(): Promise<void> {
  const ids = createdUserIds.splice(0);
  if (ids.length > 0) {
    await testPrisma().$executeRaw`DELETE FROM auth_user WHERE id = ANY(${ids}::uuid[])`;
  }
}
