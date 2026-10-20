import { PRESET_CATEGORIES, type PresetCategory } from '@finanzas/db/seed/preset-categories.js';
import { afterAll, describe, expect, it } from 'vitest';

import { createUser, deleteCreatedUsers } from '../factories/user.factory.js';
import { disconnectTestPrisma, testPrisma } from './setup/db.js';

/**
 * The plan fixes what a new user gets (§3.4, §4.5.3, §4.15.1) but not the names of the pieces.
 * These tests exercise `bootstrapUser(repos, userId)` through `createUser`, which builds the user
 * with `user-bootstrap` inside a transaction, and check the resulting rows.
 */
afterAll(async () => {
  await deleteCreatedUsers();
  await disconnectTestPrisma();
});

interface CurrencyRow {
  code: string;
  symbol: string;
  isSystem: boolean;
  status: string;
}

interface CategoryRow {
  id: string;
  kind: string;
  parentId: string | null;
  name: string;
  color: string;
  icon: string;
  isSystem: boolean;
  systemKey: string | null;
  seedOrder: number | null;
}

interface PreferenceRow {
  type: string;
  enabled: boolean;
  hour: number | null;
  weekdays: number[] | null;
}

interface SettingsRow {
  baseCurrency: string;
  numberFormat: string;
  dateFormat: string;
  weekStart: string;
  theme: string;
  sidebarCollapsed: boolean;
  usdReference: string;
  alwaysShowNote: boolean;
  onboardingStep: number;
  onboardingCompletedAt: Date | null;
  defaultAccountId: string | null;
  dashboardBlocks: { key: string; visible: boolean }[];
}

const currenciesOf = (userId: string) =>
  testPrisma().$queryRaw<CurrencyRow[]>`
    SELECT code::text AS code, symbol, is_system AS "isSystem", status::text AS status
    FROM currency WHERE user_id = ${userId}::uuid ORDER BY code`;

const categoriesOf = (userId: string) =>
  testPrisma().$queryRaw<CategoryRow[]>`
    SELECT id::text AS id, kind::text AS kind, parent_id::text AS "parentId", name, color, icon,
           is_system AS "isSystem", system_key::text AS "systemKey",
           seed_order::int AS "seedOrder"
    FROM category WHERE user_id = ${userId}::uuid`;

const preferencesOf = (userId: string) =>
  testPrisma().$queryRaw<PreferenceRow[]>`
    SELECT type::text AS type, enabled, hour::int AS hour, weekdays::int[] AS weekdays
    FROM notification_preference WHERE user_id = ${userId}::uuid`;

const settingsOf = (userId: string) =>
  testPrisma().$queryRaw<SettingsRow[]>`
    SELECT base_currency::text AS "baseCurrency", number_format::text AS "numberFormat",
           date_format::text AS "dateFormat", week_start::text AS "weekStart", theme::text AS theme,
           sidebar_collapsed AS "sidebarCollapsed", usd_reference::text AS "usdReference",
           always_show_note AS "alwaysShowNote", onboarding_step::int AS "onboardingStep",
           onboarding_completed_at AS "onboardingCompletedAt",
           default_account_id::text AS "defaultAccountId", dashboard_blocks AS "dashboardBlocks"
    FROM user_settings WHERE user_id = ${userId}::uuid`;

function flatten(presets: readonly PresetCategory[]): PresetCategory[] {
  return presets.flatMap((preset) => [preset, ...flatten(preset.children ?? [])]);
}

describe('user bootstrap: currencies and settings', () => {
  it('RF-M3-01 BOB and USD are created active and marked as system', async () => {
    const user = await createUser();

    const currencies = await currenciesOf(user.id);

    expect(currencies.map((c) => c.code)).toEqual(['BOB', 'USD']);
    for (const currency of currencies) {
      expect(currency.isSystem).toBe(true);
      expect(currency.status).toBe('active');
    }
  });

  it('RF-M3-01 user_settings starts with BOB as base currency and the plan defaults', async () => {
    const user = await createUser();

    const rows = await settingsOf(user.id);

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      baseCurrency: 'BOB',
      numberFormat: 'dot_comma',
      dateFormat: 'dmy',
      weekStart: 'monday',
      theme: 'system',
      sidebarCollapsed: false,
      usdReference: 'parallel_median',
      alwaysShowNote: false,
      onboardingStep: 1,
      onboardingCompletedAt: null,
      defaultAccountId: null,
    });
  });

  it('RF-M3-01 dashboard_blocks lists the six blocks in the order of spec 2.8.1, all visible', async () => {
    const user = await createUser();

    const [settings] = await settingsOf(user.id);

    expect(settings?.dashboardBlocks).toEqual(
      ['budget', 'byCategory', 'pace', 'upcoming', 'balances', 'recent'].map((key) => ({
        key,
        visible: true,
      })),
    );
  });
});

describe('user bootstrap: categories', () => {
  it('RF-M5-05 every preset category is created with its kind, name, icon and color', async () => {
    const user = await createUser();

    const rows = await categoriesOf(user.id);

    const expected = flatten(PRESET_CATEGORIES);
    expect(rows).toHaveLength(expected.length);
    for (const preset of expected) {
      expect(
        rows.some(
          (row) =>
            row.kind === preset.kind &&
            row.name === preset.name &&
            row.icon === preset.icon &&
            row.color === preset.color &&
            row.seedOrder === preset.seedOrder,
        ),
        `${preset.kind} ${preset.name}`,
      ).toBe(true);
    }
  });

  it('RF-M5-05 children hang from their preset parent of the same kind, with one level only', async () => {
    const user = await createUser();

    const rows = await categoriesOf(user.id);

    for (const preset of PRESET_CATEGORIES) {
      const parent = rows.find(
        (row) => row.parentId === null && row.kind === preset.kind && row.name === preset.name,
      );
      expect(parent, `${preset.kind} ${preset.name}`).toBeDefined();
      const children = rows.filter((row) => row.parentId === parent?.id);
      expect(children.map((c) => c.name).sort()).toEqual(
        (preset.children ?? []).map((c) => c.name).sort(),
      );
      for (const child of children) {
        expect(child.kind).toBe(preset.kind);
        expect(child.color).toBe(parent?.color);
      }
    }
    expect(rows.filter((row) => row.parentId === null)).toHaveLength(PRESET_CATEGORIES.length);
  });

  it('RF-M5-05 "Deudas y préstamos" and "Intereses" exist as system categories, expense and income', async () => {
    const user = await createUser();

    const rows = await categoriesOf(user.id);

    for (const kind of ['expense', 'income']) {
      const debts = rows.find((r) => r.kind === kind && r.systemKey === 'debts');
      expect(debts).toMatchObject({ name: 'Deudas y préstamos', isSystem: true, parentId: null });
      const interest = rows.find((r) => r.kind === kind && r.systemKey === 'debts_interest');
      expect(interest).toMatchObject({ name: 'Intereses', isSystem: true, parentId: debts?.id });
    }
    expect(rows.filter((r) => r.isSystem)).toHaveLength(4);
  });

  it('RF-M5-05 the other preset categories are not system categories', async () => {
    const user = await createUser();

    const rows = await categoriesOf(user.id);

    const plain = rows.filter((r) => r.systemKey === null);
    expect(plain.length).toBe(flatten(PRESET_CATEGORIES).length - 4);
    expect(plain.every((r) => !r.isSystem)).toBe(true);
  });

  it('RF-M5-05 seed_order counts per kind among roots and per parent among children', async () => {
    const user = await createUser();

    const rows = await categoriesOf(user.id);

    const groups = new Map<string, number[]>();
    for (const row of rows) {
      const key = row.parentId ?? `root:${row.kind}`;
      groups.set(key, [...(groups.get(key) ?? []), row.seedOrder ?? -1]);
    }
    for (const orders of groups.values()) {
      expect(orders.sort((a, b) => a - b)).toEqual(orders.map((_, index) => index));
    }
  });
});

describe('user bootstrap: notification preferences', () => {
  it('RF-M15-02 the six types are created, active except log_day and goal_progress', async () => {
    const user = await createUser();

    const rows = await preferencesOf(user.id);

    expect(rows).toHaveLength(6);
    const enabledOf = (type: string) => rows.find((row) => row.type === type)?.enabled;
    for (const type of ['payment_upcoming', 'budget_alert', 'period_close', 'recurring_pending']) {
      expect(enabledOf(type), type).toBe(true);
    }
    expect(enabledOf('log_day')).toBe(false);
    expect(enabledOf('goal_progress')).toBe(false);
  });

  it('RF-M15-02 log_day defaults to 21:00 every day of the week', async () => {
    const user = await createUser();

    const rows = await preferencesOf(user.id);

    const logDay = rows.find((row) => row.type === 'log_day');
    expect(logDay?.hour).toBe(21);
    expect([...(logDay?.weekdays ?? [])].sort()).toEqual([0, 1, 2, 3, 4, 5, 6]);
  });
});

describe('user bootstrap: isolation', () => {
  it('RF-M5-05 each user gets its own rows and none are shared between users', async () => {
    const first = await createUser();
    const second = await createUser();

    const firstCategories = await categoriesOf(first.id);
    const secondCategories = await categoriesOf(second.id);

    const firstIds = new Set(firstCategories.map((c) => c.id));
    expect(secondCategories.some((c) => firstIds.has(c.id))).toBe(false);
    expect(firstCategories).toHaveLength(secondCategories.length);
    expect(await currenciesOf(first.id)).toHaveLength(2);
    expect(await currenciesOf(second.id)).toHaveLength(2);
    expect(await preferencesOf(second.id)).toHaveLength(6);
  });
});
