import { randomUUID } from 'node:crypto';

import type { Page } from '@playwright/test';

import { expect, test } from './fixtures/auth.js';
import { expectNoBlockingViolations } from './support/axe.js';

interface Settings {
  defaultAccountId: string | null;
  alwaysShowNote: boolean;
  favorites: { expense: string[]; income: string[] };
}

interface CategoryNode {
  id: string;
  name: string;
  kind: string;
  status: string;
  children: CategoryNode[];
}

interface ShortcutItem {
  id: string;
  name: string;
}

const BOLIVIA_OFFSET_MS = 4 * 60 * 60 * 1000;

const pad = (n: number): string => String(n).padStart(2, '0');

/** Today in Bolivia as `YYYY-MM-DD`. */
function bolivianToday(): string {
  const now = new Date(Date.now() - BOLIVIA_OFFSET_MS);
  return `${now.getUTCFullYear()}-${pad(now.getUTCMonth() + 1)}-${pad(now.getUTCDate())}`;
}

/** The first day of the month two months back: older than any movement the tests create. */
function twoMonthsAgoStart(): string {
  const now = new Date(Date.now() - BOLIVIA_OFFSET_MS);
  const index = now.getUTCFullYear() * 12 + now.getUTCMonth() - 2;
  return `${Math.floor(index / 12)}-${pad((index % 12) + 1)}-01`;
}

async function getSettings(page: Page): Promise<Settings> {
  const res = await page.request.get('/api/settings');
  expect(res.ok()).toBe(true);
  return (await res.json()) as Settings;
}

async function createAccount(page: Page, name: string): Promise<string> {
  const id = randomUUID();
  const res = await page.request.post('/api/accounts', {
    data: {
      id,
      type: 'cash',
      name,
      currencyCode: 'BOB',
      initialBalance: '500',
      initialBalanceDate: twoMonthsAgoStart(),
      color: 'teal',
      icon: 'wallet',
    },
  });
  expect(res.status()).toBe(201);
  return id;
}

async function archiveAccount(page: Page, id: string): Promise<void> {
  const res = await page.request.post(`/api/accounts/${id}/archive`, {
    data: { confirmNonZero: true },
  });
  expect(res.status()).toBe(200);
}

/** The active top-level categories of one kind, by name. */
async function categoryIdsByName(
  page: Page,
  kind: 'expense' | 'income',
): Promise<Map<string, string>> {
  const res = await page.request.get(`/api/categories?kind=${kind}&status=active`);
  expect(res.ok()).toBe(true);
  const roots = (await res.json()) as CategoryNode[];
  return new Map(roots.map((node) => [node.name, node.id]));
}

function idOf(ids: Map<string, string>, name: string): string {
  const id = ids.get(name);
  expect(id, `the preloaded category ${name}`).toBeDefined();
  return id ?? '';
}

async function createShortcut(
  page: Page,
  name: string,
  accountId: string,
  categoryId: string,
): Promise<string> {
  const id = randomUUID();
  const res = await page.request.post('/api/shortcuts', {
    data: { id, name, kind: 'expense', accountId, categoryId },
  });
  expect(res.status()).toBe(201);
  return id;
}

async function shortcutNames(page: Page): Promise<string[]> {
  const res = await page.request.get('/api/shortcuts');
  expect(res.ok()).toBe(true);
  return ((await res.json()) as { items: ShortcutItem[] }).items.map((item) => item.name);
}

/** The names of the shortcut chips of Registrar, in the order they show. */
async function registerShortcutOrder(page: Page, names: readonly string[]): Promise<string[]> {
  const pattern = new RegExp(`^(${names.join('|')})$`);
  return page.locator('form').getByRole('button', { name: pattern }).allTextContents();
}

/** The names of the first `count` category chips of the Registrar grid. */
async function gridNames(page: Page, count: number): Promise<string[]> {
  const chips = page.getByRole('group', { name: 'Categoría', exact: true }).getByRole('button');
  const texts = await chips.allTextContents();
  return texts.slice(0, count).map((text) => text.trim());
}

/** The row of a shortcut in Ajustes › Registrar. */
function shortcutRow(page: Page, name: string) {
  return page.getByRole('listitem').filter({ hasText: name }).last();
}

/**
 * Picks the account in the "Cuenta por defecto" control, whether it is a native select, a custom
 * select or a group of radio buttons.
 */
async function chooseDefaultAccount(page: Page, name: string): Promise<void> {
  const combo = page.getByRole('combobox', { name: /cuenta por defecto/i });
  if ((await combo.count()) === 0) {
    await page.getByRole('radio', { name }).check();
    return;
  }
  const tag = await combo.evaluate((element) => element.tagName);
  if (tag === 'SELECT') {
    const value = await combo.locator('option', { hasText: name }).getAttribute('value');
    expect(value, `the option of ${name}`).not.toBeNull();
    await combo.selectOption(value ?? '');
    return;
  }
  await combo.click();
  await page.getByRole('option', { name }).click();
}

test.describe('TASK-152 Ajustes de Registrar', () => {
  test('TASK-152 /ajustes lleva a /ajustes/registrar y la sección muestra sus ajustes', async ({
    authedPage,
  }) => {
    await createAccount(authedPage, 'Cuenta Ana');
    await authedPage.goto('/ajustes');
    const main = authedPage.getByRole('main');
    await main.getByRole('link', { name: /Registrar/ }).click();
    await expect(authedPage).toHaveURL(/\/ajustes\/registrar$/);
    await expect(main.getByRole('heading', { name: 'Registrar' })).toBeVisible();
    await expect(main.getByText(/cuenta por defecto/i).first()).toBeVisible();
    await expect(authedPage.getByLabel('Mostrar la nota siempre')).toBeVisible();
    // The settings of this section save by themselves (RF-M9-01).
    await expect(authedPage.getByRole('button', { name: 'Guardar', exact: true })).toHaveCount(0);
  });

  test('RF-M7-04 las favoritas elegidas aparecen primero en la grilla de Registrar', async ({
    authedPage,
  }) => {
    await createAccount(authedPage, 'Cuenta Ana');
    const ids = await categoryIdsByName(authedPage, 'expense');
    const chosen = ['Mascotas', 'Regalos', 'Otros gastos'];

    await authedPage.goto('/ajustes/registrar');
    for (const name of chosen) {
      await authedPage.getByLabel(name, { exact: true }).check();
    }
    await expect
      .poll(async () => [...(await getSettings(authedPage)).favorites.expense].sort(), {
        timeout: 10_000,
      })
      .toEqual(chosen.map((name) => idOf(ids, name)).sort());

    await authedPage.goto('/registrar');
    await expect
      .poll(async () => (await gridNames(authedPage, 3)).sort(), { timeout: 10_000 })
      .toEqual([...chosen].sort());
    // After them, the preloaded ones in their order: a new user sees Comida first.
    expect(await gridNames(authedPage, 4)).toContain('Comida');
  });

  test('RF-M7-04 las favoritas son hasta 8 por tipo', async ({ authedPage }) => {
    await createAccount(authedPage, 'Cuenta Ana');
    const ids = await categoryIdsByName(authedPage, 'expense');
    const eight = [
      'Comida',
      'Transporte',
      'Vivienda',
      'Servicios',
      'Salud',
      'Educación',
      'Ocio',
      'Ropa',
    ];
    const saved = await authedPage.request.patch('/api/settings', {
      data: { favoriteCategories: { kind: 'expense', ids: eight.map((name) => idOf(ids, name)) } },
    });
    expect(saved.status()).toBe(200);

    await authedPage.goto('/ajustes/registrar');
    await expect(authedPage.getByLabel('Comida', { exact: true })).toBeChecked();

    // A ninth favorite of the same kind is not taken.
    await authedPage
      .getByLabel('Mascotas', { exact: true })
      .click({ force: true, timeout: 2_000 })
      .catch(() => undefined);
    await authedPage.waitForTimeout(1_000);
    expect((await getSettings(authedPage)).favorites.expense).toHaveLength(8);
    await expect(authedPage.getByLabel('Mascotas', { exact: true })).not.toBeChecked();
  });

  test('RF-M7-04 quitar una favorita la saca de la lista guardada', async ({ authedPage }) => {
    await createAccount(authedPage, 'Cuenta Ana');
    const ids = await categoryIdsByName(authedPage, 'expense');
    const saved = await authedPage.request.patch('/api/settings', {
      data: {
        favoriteCategories: {
          kind: 'expense',
          ids: [idOf(ids, 'Mascotas'), idOf(ids, 'Regalos')],
        },
      },
    });
    expect(saved.status()).toBe(200);

    await authedPage.goto('/ajustes/registrar');
    await expect(authedPage.getByLabel('Mascotas', { exact: true })).toBeChecked();
    await authedPage.getByLabel('Mascotas', { exact: true }).uncheck();
    await expect
      .poll(async () => (await getSettings(authedPage)).favorites.expense, { timeout: 10_000 })
      .toEqual([idOf(ids, 'Regalos')]);
  });

  test('EC-M9-02 después de archivar la cuenta por defecto, Registrar preselecciona la primera activa', async ({
    authedPage,
  }) => {
    await createAccount(authedPage, 'Cuenta Ana');
    await createAccount(authedPage, 'Cuenta Carla');
    const beto = await createAccount(authedPage, 'Cuenta Beto');

    await authedPage.goto('/ajustes/registrar');
    await chooseDefaultAccount(authedPage, 'Cuenta Beto');
    await expect
      .poll(async () => (await getSettings(authedPage)).defaultAccountId, { timeout: 10_000 })
      .toBe(beto);

    // With the default account, Registrar opens on it (RF-M7-03).
    await authedPage.goto('/registrar');
    await expect(
      authedPage.locator('form').getByText('Cuenta Beto', { exact: true }).first(),
    ).toBeVisible();

    await archiveAccount(authedPage, beto);

    // The setting is cleared and RF-M7-03 applies: no last used, so the first active in order.
    await expect
      .poll(async () => (await getSettings(authedPage)).defaultAccountId, { timeout: 10_000 })
      .toBeNull();
    await authedPage.goto('/registrar');
    await expect(
      authedPage.locator('form').getByText('Cuenta Ana', { exact: true }).first(),
    ).toBeVisible();
    await expect(authedPage.getByText('Cuenta Beto')).toHaveCount(0);

    // Ajustes shows no default account and does not offer the archived one.
    await authedPage.goto('/ajustes/registrar');
    await expect(authedPage.getByText('Cuenta Ana').first()).toBeAttached();
    await expect(authedPage.getByText('Cuenta Beto')).toHaveCount(0);
  });

  test('EC-M9-02 después de archivar la cuenta por defecto, Registrar preselecciona la última usada', async ({
    authedPage,
  }) => {
    await createAccount(authedPage, 'Cuenta Ana');
    const carla = await createAccount(authedPage, 'Cuenta Carla');
    const beto = await createAccount(authedPage, 'Cuenta Beto');
    const ids = await categoryIdsByName(authedPage, 'expense');
    const spent = await authedPage.request.post('/api/transactions', {
      data: {
        kind: 'expense',
        id: randomUUID(),
        accountId: carla,
        categoryId: idOf(ids, 'Comida'),
        amount: '10',
        date: bolivianToday(),
      },
    });
    expect(spent.status()).toBe(201);

    await authedPage.goto('/ajustes/registrar');
    await chooseDefaultAccount(authedPage, 'Cuenta Beto');
    await expect
      .poll(async () => (await getSettings(authedPage)).defaultAccountId, { timeout: 10_000 })
      .toBe(beto);
    await archiveAccount(authedPage, beto);
    await expect
      .poll(async () => (await getSettings(authedPage)).defaultAccountId, { timeout: 10_000 })
      .toBeNull();

    await authedPage.goto('/registrar');
    await expect(
      authedPage.locator('form').getByText('Cuenta Carla', { exact: true }).first(),
    ).toBeVisible();
    await expect(authedPage.locator('form').getByText('Cuenta Ana', { exact: true })).toHaveCount(
      0,
    );
  });

  test('RF-M7-03 la cuenta por defecto elegida en Ajustes es la preseleccionada en Registrar', async ({
    authedPage,
  }) => {
    await createAccount(authedPage, 'Cuenta Ana');
    const carla = await createAccount(authedPage, 'Cuenta Carla');

    await authedPage.goto('/ajustes/registrar');
    await chooseDefaultAccount(authedPage, 'Cuenta Carla');
    await expect
      .poll(async () => (await getSettings(authedPage)).defaultAccountId, { timeout: 10_000 })
      .toBe(carla);

    await authedPage.goto('/registrar');
    await expect(
      authedPage.locator('form').getByText('Cuenta Carla', { exact: true }).first(),
    ).toBeVisible();
  });

  test('RF-M7-10 reordenar los atajos con el teclado se refleja en Registrar', async ({
    authedPage,
  }) => {
    const account = await createAccount(authedPage, 'Cuenta Ana');
    const ids = await categoryIdsByName(authedPage, 'expense');
    const category = idOf(ids, 'Comida');
    const names = ['Almuerzo', 'Pasaje', 'Cafetería'];
    for (const name of names) {
      await createShortcut(authedPage, name, account, category);
    }
    await expect.poll(() => shortcutNames(authedPage)).toEqual(names);

    await authedPage.goto('/ajustes/registrar');
    await expect(shortcutRow(authedPage, 'Almuerzo')).toBeVisible();

    // "Bajar" on the first one, with the keyboard alone.
    await shortcutRow(authedPage, 'Almuerzo').getByRole('button', { name: /Bajar/ }).focus();
    await authedPage.keyboard.press('Enter');
    await expect
      .poll(() => shortcutNames(authedPage), { timeout: 10_000 })
      .toEqual(['Pasaje', 'Almuerzo', 'Cafetería']);

    // "Subir" on the last one.
    await shortcutRow(authedPage, 'Cafetería').getByRole('button', { name: /Subir/ }).focus();
    await authedPage.keyboard.press('Enter');
    await expect
      .poll(() => shortcutNames(authedPage), { timeout: 10_000 })
      .toEqual(['Pasaje', 'Cafetería', 'Almuerzo']);

    await authedPage.goto('/registrar');
    await expect
      .poll(() => registerShortcutOrder(authedPage, names), { timeout: 10_000 })
      .toEqual(['Pasaje', 'Cafetería', 'Almuerzo']);
  });

  test('RF-M7-10 el primer atajo no se puede subir ni el último bajar', async ({ authedPage }) => {
    const account = await createAccount(authedPage, 'Cuenta Ana');
    const ids = await categoryIdsByName(authedPage, 'expense');
    for (const name of ['Almuerzo', 'Pasaje']) {
      await createShortcut(authedPage, name, account, idOf(ids, 'Comida'));
    }

    await authedPage.goto('/ajustes/registrar');
    await expect(shortcutRow(authedPage, 'Almuerzo')).toBeVisible();
    await expect(
      shortcutRow(authedPage, 'Almuerzo').getByRole('button', { name: /Subir/ }),
    ).toBeDisabled();
    await expect(
      shortcutRow(authedPage, 'Pasaje').getByRole('button', { name: /Bajar/ }),
    ).toBeDisabled();
  });

  test('RF-M7-10 un atajo se edita en Ajustes › Registrar', async ({ authedPage }) => {
    const account = await createAccount(authedPage, 'Cuenta Ana');
    const ids = await categoryIdsByName(authedPage, 'expense');
    await createShortcut(authedPage, 'Almuerzo', account, idOf(ids, 'Comida'));

    await authedPage.goto('/ajustes/registrar');
    await shortcutRow(authedPage, 'Almuerzo')
      .getByRole('button', { name: /Editar/ })
      .click();
    await authedPage.getByLabel(/nombre/i).fill('Comida del día');
    await authedPage.getByRole('button', { name: /guardar/i }).click();

    await expect
      .poll(() => shortcutNames(authedPage), { timeout: 10_000 })
      .toEqual(['Comida del día']);
    await authedPage.goto('/registrar');
    await expect(
      authedPage.locator('form').getByRole('button', { name: 'Comida del día', exact: true }),
    ).toBeVisible();
  });

  test('RF-M7-10 un atajo se elimina en Ajustes › Registrar', async ({ authedPage }) => {
    const account = await createAccount(authedPage, 'Cuenta Ana');
    const ids = await categoryIdsByName(authedPage, 'expense');
    const category = idOf(ids, 'Comida');
    await createShortcut(authedPage, 'Almuerzo', account, category);
    await createShortcut(authedPage, 'Pasaje', account, category);

    await authedPage.goto('/ajustes/registrar');
    await shortcutRow(authedPage, 'Almuerzo')
      .getByRole('button', { name: /Eliminar/ })
      .click();
    // If the app asks for a confirmation, accept it.
    await authedPage
      .getByRole('dialog')
      .getByRole('button', { name: /Eliminar/ })
      .click({ timeout: 1_500 })
      .catch(() => undefined);

    await expect.poll(() => shortcutNames(authedPage), { timeout: 10_000 }).toEqual(['Pasaje']);
    await authedPage.goto('/registrar');
    await expect(
      authedPage.locator('form').getByRole('button', { name: 'Pasaje', exact: true }),
    ).toBeVisible();
    await expect(
      authedPage.locator('form').getByRole('button', { name: 'Almuerzo', exact: true }),
    ).toHaveCount(0);
  });

  test('RF-M7-13 activar la nota la muestra en el primer nivel de Registrar', async ({
    authedPage,
  }) => {
    await createAccount(authedPage, 'Cuenta Ana');

    // By default the note lives in the second level, behind "Más opciones".
    await authedPage.goto('/registrar');
    await expect(authedPage.getByRole('button', { name: 'Más opciones' })).toBeVisible();
    await expect(authedPage.getByLabel('Nota', { exact: true })).toHaveCount(0);

    await authedPage.goto('/ajustes/registrar');
    await authedPage.getByLabel('Mostrar la nota siempre').click();
    await expect
      .poll(async () => (await getSettings(authedPage)).alwaysShowNote, { timeout: 10_000 })
      .toBe(true);

    await authedPage.goto('/registrar');
    await expect(authedPage.getByLabel('Nota', { exact: true })).toBeVisible();

    // Turning it off puts the note back in the second level.
    await authedPage.goto('/ajustes/registrar');
    await authedPage.getByLabel('Mostrar la nota siempre').click();
    await expect
      .poll(async () => (await getSettings(authedPage)).alwaysShowNote, { timeout: 10_000 })
      .toBe(false);
    await authedPage.goto('/registrar');
    await expect(authedPage.getByLabel('Nota', { exact: true })).toHaveCount(0);
  });

  test('RNF-06 /ajustes/registrar se usa con el teclado y no tiene fallas serias de accesibilidad', async ({
    authedPage,
  }) => {
    const account = await createAccount(authedPage, 'Cuenta Ana');
    const ids = await categoryIdsByName(authedPage, 'expense');
    await createShortcut(authedPage, 'Almuerzo', account, idOf(ids, 'Comida'));
    await createShortcut(authedPage, 'Pasaje', account, idOf(ids, 'Comida'));

    await authedPage.goto('/ajustes/registrar');
    await expect(shortcutRow(authedPage, 'Almuerzo')).toBeVisible();
    await expectNoBlockingViolations(authedPage);

    // Reordering has buttons, not only gestures: "Subir" and "Bajar" are reachable with Tab.
    const down = shortcutRow(authedPage, 'Almuerzo').getByRole('button', { name: /Bajar/ });
    await down.focus();
    await expect(down).toBeFocused();
    await expect(
      shortcutRow(authedPage, 'Pasaje').getByRole('button', { name: /Subir/ }),
    ).toBeEnabled();

    // The note setting is operated with the keyboard.
    const note = authedPage.getByLabel('Mostrar la nota siempre');
    await note.focus();
    await authedPage.keyboard.press('Space');
    await expect
      .poll(async () => (await getSettings(authedPage)).alwaysShowNote, { timeout: 10_000 })
      .toBe(true);
  });
});
