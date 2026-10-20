import { describe, expect, it } from 'vitest';

import { DEFAULT_DASHBOARD_BLOCKS, ResetSettingsInput, UpdateSettingsInput } from '../src/index.js';

const ok = (schema: { safeParse: (v: unknown) => { success: boolean } }, v: unknown) =>
  schema.safeParse(v).success;

const BLOCK_KEYS = ['budget', 'byCategory', 'pace', 'upcoming', 'balances', 'recent'] as const;

const ID = (n: number) => `0192f3a4-5b6c-7d8e-9f01-${String(n).padStart(12, '0')}`;

const blocks = (keys: readonly string[] = BLOCK_KEYS) =>
  keys.map((key) => ({ key, visible: true }));

describe('UpdateSettingsInput: barra lateral (RF-M2-09)', () => {
  it('RF-M2-09 { sidebarCollapsed: true } es una entrada válida', () => {
    expect(ok(UpdateSettingsInput, { sidebarCollapsed: true })).toBe(true);
  });

  it('RF-M2-09 { sidebarCollapsed: false } es una entrada válida', () => {
    expect(ok(UpdateSettingsInput, { sidebarCollapsed: false })).toBe(true);
  });

  it('RF-M2-09 sidebarCollapsed rechaza un valor no booleano', () => {
    expect(ok(UpdateSettingsInput, { sidebarCollapsed: 'true' })).toBe(false);
  });

  it('RF-M2-09 un campo desconocido no es válido', () => {
    expect(ok(UpdateSettingsInput, { sidebarCollapsed: true, foo: 1 })).toBe(false);
    expect(ok(UpdateSettingsInput, { foo: 1 })).toBe(false);
  });

  it('RF-M2-09 pick({ sidebarCollapsed }) acepta solo la barra lateral', () => {
    const SidebarInput = UpdateSettingsInput.pick({ sidebarCollapsed: true });
    expect(ok(SidebarInput, { sidebarCollapsed: true })).toBe(true);
    expect(ok(SidebarInput, { sidebarCollapsed: true, theme: 'dark' })).toBe(false);
  });
});

describe('UpdateSettingsInput: parcial y estricto (RF-M9-01)', () => {
  it('RF-M9-01 un objeto vacío es válido (parcial)', () => {
    expect(ok(UpdateSettingsInput, {})).toBe(true);
  });

  it('RF-M9-01 el tema acepta system, light y dark', () => {
    for (const theme of ['system', 'light', 'dark']) {
      expect(ok(UpdateSettingsInput, { theme }), theme).toBe(true);
    }
    expect(ok(UpdateSettingsInput, { theme: 'blue' })).toBe(false);
  });

  it('RF-M9-01 acepta todos los campos de ajustes juntos', () => {
    expect(
      ok(UpdateSettingsInput, {
        numberFormat: 'dot_comma',
        dateFormat: 'dmy',
        weekStart: 'monday',
        theme: 'dark',
        sidebarCollapsed: true,
        defaultAccountId: ID(1),
        alwaysShowNote: false,
        dashboardBlocks: blocks(),
        favoriteCategories: { kind: 'expense', ids: [ID(2)] },
      }),
    ).toBe(true);
  });

  it('RF-M9-01 los enums de formato y semana aceptan sus valores y rechazan otros', () => {
    for (const numberFormat of ['dot_comma', 'comma_dot']) {
      expect(ok(UpdateSettingsInput, { numberFormat })).toBe(true);
    }
    expect(ok(UpdateSettingsInput, { numberFormat: 'space_dot' })).toBe(false);
    for (const dateFormat of ['dmy', 'iso', 'short_text']) {
      expect(ok(UpdateSettingsInput, { dateFormat })).toBe(true);
    }
    expect(ok(UpdateSettingsInput, { dateFormat: 'mdy' })).toBe(false);
    for (const weekStart of ['monday', 'sunday']) {
      expect(ok(UpdateSettingsInput, { weekStart })).toBe(true);
    }
    expect(ok(UpdateSettingsInput, { weekStart: 'saturday' })).toBe(false);
  });

  it('RF-M9-01 defaultAccountId admite un uuid o null, y rechaza otro texto', () => {
    expect(ok(UpdateSettingsInput, { defaultAccountId: ID(1) })).toBe(true);
    expect(ok(UpdateSettingsInput, { defaultAccountId: null })).toBe(true);
    expect(ok(UpdateSettingsInput, { defaultAccountId: 'abc' })).toBe(false);
  });

  it('RF-M9-01 alwaysShowNote exige un booleano', () => {
    expect(ok(UpdateSettingsInput, { alwaysShowNote: true })).toBe(true);
    expect(ok(UpdateSettingsInput, { alwaysShowNote: 1 })).toBe(false);
  });
});

describe('UpdateSettingsInput: dashboardBlocks (RF-M8-10)', () => {
  it('RF-M8-10 seis bloques con claves válidas son válidos', () => {
    expect(ok(UpdateSettingsInput, { dashboardBlocks: blocks() })).toBe(true);
  });

  it('RF-M8-10 seis bloques reordenados y algunos ocultos son válidos', () => {
    const reordered = [...BLOCK_KEYS].reverse().map((key, i) => ({ key, visible: i % 2 === 0 }));
    expect(ok(UpdateSettingsInput, { dashboardBlocks: reordered })).toBe(true);
  });

  it('RF-M8-10 menos de 6 bloques no es válido', () => {
    expect(ok(UpdateSettingsInput, { dashboardBlocks: blocks(BLOCK_KEYS.slice(0, 5)) })).toBe(false);
    expect(ok(UpdateSettingsInput, { dashboardBlocks: [] })).toBe(false);
  });

  it('RF-M8-10 más de 6 bloques no es válido', () => {
    expect(
      ok(UpdateSettingsInput, { dashboardBlocks: blocks([...BLOCK_KEYS, 'recent']) }),
    ).toBe(false);
  });

  it('RF-M8-10 una clave inválida no es válida', () => {
    const keys = [...BLOCK_KEYS.slice(0, 5), 'monthSelector'];
    expect(ok(UpdateSettingsInput, { dashboardBlocks: blocks(keys) })).toBe(false);
  });

  it('RF-M8-10 cada bloque exige visible booleano', () => {
    const bad = blocks().map((b, i) => (i === 0 ? { key: b.key } : b));
    expect(ok(UpdateSettingsInput, { dashboardBlocks: bad })).toBe(false);
  });

  it('RF-M8-10 DEFAULT_DASHBOARD_BLOCKS son los bloques 3 a 8 en el orden por defecto y visibles', () => {
    expect(DEFAULT_DASHBOARD_BLOCKS.map((b) => b.key)).toEqual([...BLOCK_KEYS]);
    for (const b of DEFAULT_DASHBOARD_BLOCKS) {
      expect(b.visible, b.key).toBe(true);
    }
  });

  it('RF-M8-10 DEFAULT_DASHBOARD_BLOCKS es una entrada válida de dashboardBlocks', () => {
    expect(ok(UpdateSettingsInput, { dashboardBlocks: DEFAULT_DASHBOARD_BLOCKS })).toBe(true);
  });
});

describe('UpdateSettingsInput: favoriteCategories (TASK-068)', () => {
  it('TASK-068 favoriteCategories admite hasta 8 ids', () => {
    const ids = Array.from({ length: 8 }, (_, i) => ID(i + 1));
    expect(ok(UpdateSettingsInput, { favoriteCategories: { kind: 'expense', ids } })).toBe(true);
    expect(ok(UpdateSettingsInput, { favoriteCategories: { kind: 'income', ids: [] } })).toBe(
      true,
    );
  });

  it('TASK-068 favoriteCategories con 9 ids no es válido', () => {
    const ids = Array.from({ length: 9 }, (_, i) => ID(i + 1));
    expect(ok(UpdateSettingsInput, { favoriteCategories: { kind: 'expense', ids } })).toBe(false);
  });

  it('TASK-068 favoriteCategories exige ids uuid y un tipo válido', () => {
    expect(
      ok(UpdateSettingsInput, { favoriteCategories: { kind: 'expense', ids: ['abc'] } }),
    ).toBe(false);
    expect(
      ok(UpdateSettingsInput, { favoriteCategories: { kind: 'transfer', ids: [ID(1)] } }),
    ).toBe(false);
  });
});

describe('ResetSettingsInput (TASK-068)', () => {
  it('TASK-068 acepta las secciones general, currencies, register, dashboard y reminders', () => {
    for (const section of ['general', 'currencies', 'register', 'dashboard', 'reminders']) {
      expect(ok(ResetSettingsInput, { section }), section).toBe(true);
    }
  });

  it('TASK-068 rechaza una sección desconocida o ausente', () => {
    expect(ok(ResetSettingsInput, { section: 'profile' })).toBe(false);
    expect(ok(ResetSettingsInput, {})).toBe(false);
  });
});
