import { randomUUID } from 'node:crypto';

import type { Locator, Page } from '@playwright/test';

import { expect, test } from './fixtures/auth.js';
import { expectNoBlockingViolations } from './support/axe.js';

interface Block {
  key: string;
  visible: boolean;
}

interface Settings {
  dashboardBlocks: Block[];
}

interface CategoryNode {
  id: string;
  kind: string;
  status: string;
  children: CategoryNode[];
}

/** The released blocks (3 to 8) with the title they show, in the default order. */
const TITLES = {
  byCategory: 'Gasto por categoría',
  pace: 'Ritmo del gasto',
  balances: 'Saldos por cuenta',
  recent: 'Últimos movimientos',
} as const;

type ReleasedKey = keyof typeof TITLES;

const RELEASED_KEYS = Object.keys(TITLES) as ReleasedKey[];

const DEFAULT_KEYS = ['budget', 'byCategory', 'pace', 'upcoming', 'balances', 'recent'] as const;

const BOLIVIA_OFFSET_MS = 4 * 60 * 60 * 1000;

const pad = (n: number): string => String(n).padStart(2, '0');

function bolivianToday(): { y: number; m: number; d: number } {
  const now = new Date(Date.now() - BOLIVIA_OFFSET_MS);
  return { y: now.getUTCFullYear(), m: now.getUTCMonth() + 1, d: now.getUTCDate() };
}

function todayText(): string {
  const t = bolivianToday();
  return `${t.y}-${pad(t.m)}-${pad(t.d)}`;
}

function previousMonthStart(): string {
  const { y, m } = bolivianToday();
  const index = y * 12 + (m - 1) - 1;
  return `${Math.floor(index / 12)}-${pad((index % 12) + 1)}-01`;
}

function flatten(nodes: CategoryNode[]): CategoryNode[] {
  return nodes.flatMap((n) => [n, ...flatten(n.children)]);
}

async function getBlocks(page: Page): Promise<Block[]> {
  const res = await page.request.get('/api/settings');
  expect(res.ok()).toBe(true);
  return ((await res.json()) as Settings).dashboardBlocks;
}

/** The keys of the released blocks in the saved order. */
async function savedReleasedOrder(page: Page): Promise<string[]> {
  const blocks = await getBlocks(page);
  return blocks.map((block) => block.key).filter((key) => key in TITLES);
}

async function saveBlocks(page: Page, blocks: Block[]): Promise<void> {
  const res = await page.request.patch('/api/settings', { data: { dashboardBlocks: blocks } });
  expect(res.status()).toBe(200);
}

/** The default six blocks with the given keys reordered to the front and some hidden. */
function blocksWith(order: readonly string[], hidden: readonly string[] = []): Block[] {
  const rest = DEFAULT_KEYS.filter((key) => !order.includes(key));
  return [...order, ...rest].map((key) => ({ key, visible: !hidden.includes(key) }));
}

async function seedData(page: Page): Promise<void> {
  const accountId = randomUUID();
  const account = await page.request.post('/api/accounts', {
    data: {
      id: accountId,
      type: 'cash',
      name: 'Efectivo',
      currencyCode: 'BOB',
      initialBalance: '500',
      initialBalanceDate: previousMonthStart(),
      color: 'teal',
      icon: 'wallet',
    },
  });
  expect(account.status()).toBe(201);
  const categories = await page.request.get('/api/categories?kind=expense&status=active');
  expect(categories.ok()).toBe(true);
  const category = flatten((await categories.json()) as CategoryNode[]).find(
    (node) => node.kind === 'expense' && node.status === 'active',
  );
  expect(category).toBeDefined();
  const expense = await page.request.post('/api/transactions', {
    data: {
      kind: 'expense',
      id: randomUUID(),
      accountId,
      categoryId: category?.id,
      amount: '40',
      date: todayText(),
    },
  });
  expect(expense.status()).toBe(201);
}

/** The row of a block in Ajustes › Inicio. */
function blockRow(page: Page, key: ReleasedKey): Locator {
  return page.getByRole('listitem').filter({ hasText: TITLES[key] }).last();
}

/** The visibility control of a block: a switch or a checkbox. */
function visibilityOf(page: Page, key: ReleasedKey): Locator {
  const row = blockRow(page, key);
  return row.getByRole('switch').or(row.getByRole('checkbox'));
}

/** The released blocks of the Ajustes › Inicio list, in the order they show. */
async function settingsListOrder(page: Page): Promise<string[]> {
  const texts = await page.getByRole('main').getByRole('listitem').allTextContents();
  return texts.flatMap((text) => RELEASED_KEYS.filter((key) => text.includes(TITLES[key])));
}

/** The released blocks of the Inicio, in the order they show (hidden ones are absent). */
async function inicioOrder(page: Page): Promise<string[]> {
  const text = await page.getByRole('main').innerText();
  return RELEASED_KEYS.map((key) => ({ key, at: text.indexOf(TITLES[key]) }))
    .filter(({ at }) => at >= 0)
    .sort((a, b) => a.at - b.at)
    .map(({ key }) => key);
}

async function openInicio(page: Page): Promise<void> {
  await page.goto('/');
  await expect(page.getByText('Saldos al día de hoy').first()).toBeVisible();
}

test.describe('TASK-153 Ajustes del Inicio', () => {
  test('TASK-153 /ajustes lleva a /ajustes/inicio y la sección lista los bloques liberados', async ({
    authedPage,
  }) => {
    await authedPage.goto('/ajustes');
    const main = authedPage.getByRole('main');
    await main.getByRole('link', { name: /Inicio/ }).click();
    await expect(authedPage).toHaveURL(/\/ajustes\/inicio$/);
    await expect(main.getByRole('heading', { name: 'Inicio' })).toBeVisible();

    // Blocks 3 to 8 that are released: the ones of V1.1 are not shown, but remain saved.
    await expect(main.getByRole('listitem')).toHaveCount(RELEASED_KEYS.length);
    expect(await settingsListOrder(authedPage)).toEqual(['byCategory', 'pace', 'balances', 'recent']);
    for (const key of RELEASED_KEYS) {
      await expect(visibilityOf(authedPage, key)).toBeChecked();
    }
    expect(await getBlocks(authedPage)).toHaveLength(DEFAULT_KEYS.length);
    // The settings of this section save by themselves.
    await expect(authedPage.getByRole('button', { name: 'Guardar', exact: true })).toHaveCount(0);
  });

  test('RF-M8-10 la lista de Ajustes muestra el orden y la visibilidad guardados', async ({
    authedPage,
  }) => {
    await saveBlocks(authedPage, blocksWith(['recent', 'pace'], ['balances']));

    await authedPage.goto('/ajustes/inicio');
    await expect(blockRow(authedPage, 'recent')).toBeVisible();
    expect(await settingsListOrder(authedPage)).toEqual(['recent', 'pace', 'byCategory', 'balances']);
    await expect(visibilityOf(authedPage, 'balances')).not.toBeChecked();
    await expect(visibilityOf(authedPage, 'recent')).toBeChecked();
  });

  test('RF-M8-10 ocultar Ritmo del gasto lo quita del Inicio', async ({ authedPage }) => {
    await seedData(authedPage);
    await openInicio(authedPage);
    await expect(authedPage.getByText(TITLES.pace).first()).toBeVisible();

    await authedPage.goto('/ajustes/inicio');
    await expect(visibilityOf(authedPage, 'pace')).toBeChecked();
    await visibilityOf(authedPage, 'pace').click();
    await expect(visibilityOf(authedPage, 'pace')).not.toBeChecked();
    await expect
      .poll(async () => (await getBlocks(authedPage)).find((b) => b.key === 'pace')?.visible, {
        timeout: 10_000,
      })
      .toBe(false);
    // The block stays in the list, hidden, so it can be shown again.
    await expect(blockRow(authedPage, 'pace')).toBeVisible();

    await openInicio(authedPage);
    await expect(authedPage.getByText(TITLES.pace)).toHaveCount(0);
    expect(await inicioOrder(authedPage)).toEqual(['byCategory', 'balances', 'recent']);
  });

  test('RF-M8-10 volver a mostrar un bloque oculto lo devuelve al Inicio en su lugar', async ({
    authedPage,
  }) => {
    await seedData(authedPage);
    await saveBlocks(authedPage, blocksWith([], ['pace']));

    await authedPage.goto('/ajustes/inicio');
    await expect(visibilityOf(authedPage, 'pace')).not.toBeChecked();
    await visibilityOf(authedPage, 'pace').click();
    await expect
      .poll(async () => (await getBlocks(authedPage)).find((b) => b.key === 'pace')?.visible, {
        timeout: 10_000,
      })
      .toBe(true);

    await openInicio(authedPage);
    await expect(authedPage.getByText(TITLES.pace).first()).toBeVisible();
    expect(await inicioOrder(authedPage)).toEqual(['byCategory', 'pace', 'balances', 'recent']);
  });

  test('RF-M8-10 mover Ritmo del gasto arriba cambia el orden en Ajustes y en el Inicio', async ({
    authedPage,
  }) => {
    await seedData(authedPage);
    await openInicio(authedPage);
    expect(await inicioOrder(authedPage)).toEqual(['byCategory', 'pace', 'balances', 'recent']);

    await authedPage.goto('/ajustes/inicio');
    await expect(blockRow(authedPage, 'pace')).toBeVisible();
    await blockRow(authedPage, 'pace')
      .getByRole('button', { name: /Subir/ })
      .click();
    await expect
      .poll(() => savedReleasedOrder(authedPage), { timeout: 10_000 })
      .toEqual(['pace', 'byCategory', 'balances', 'recent']);
    await expect
      .poll(() => settingsListOrder(authedPage), { timeout: 10_000 })
      .toEqual(['pace', 'byCategory', 'balances', 'recent']);
    // The blocks that are not released keep their place in the saved list.
    expect(await getBlocks(authedPage)).toHaveLength(DEFAULT_KEYS.length);

    await openInicio(authedPage);
    await expect
      .poll(() => inicioOrder(authedPage), { timeout: 10_000 })
      .toEqual(['pace', 'byCategory', 'balances', 'recent']);
  });

  test('RF-M8-10 mover un bloque abajo cambia el orden en el Inicio', async ({ authedPage }) => {
    await seedData(authedPage);
    await authedPage.goto('/ajustes/inicio');
    await expect(blockRow(authedPage, 'byCategory')).toBeVisible();
    await blockRow(authedPage, 'byCategory')
      .getByRole('button', { name: /Bajar/ })
      .click();
    await expect
      .poll(() => savedReleasedOrder(authedPage), { timeout: 10_000 })
      .toEqual(['pace', 'byCategory', 'balances', 'recent']);

    await openInicio(authedPage);
    await expect
      .poll(() => inicioOrder(authedPage), { timeout: 10_000 })
      .toEqual(['pace', 'byCategory', 'balances', 'recent']);
  });

  test('RF-M8-10 ocultar y mover no cambian la visibilidad ni el orden de los demás bloques', async ({
    authedPage,
  }) => {
    await authedPage.goto('/ajustes/inicio');
    await expect(blockRow(authedPage, 'recent')).toBeVisible();
    await visibilityOf(authedPage, 'balances').click();
    await expect
      .poll(async () => (await getBlocks(authedPage)).find((b) => b.key === 'balances')?.visible, {
        timeout: 10_000,
      })
      .toBe(false);
    await blockRow(authedPage, 'recent')
      .getByRole('button', { name: /Subir/ })
      .click();
    await expect
      .poll(() => savedReleasedOrder(authedPage), { timeout: 10_000 })
      .toEqual(['byCategory', 'pace', 'recent', 'balances']);

    const blocks = await getBlocks(authedPage);
    expect(blocks.filter((b) => b.visible === false).map((b) => b.key)).toEqual(['balances']);
  });

  test('RNF-06 el primer bloque no se puede subir ni el último bajar', async ({ authedPage }) => {
    await authedPage.goto('/ajustes/inicio');
    await expect(blockRow(authedPage, 'byCategory')).toBeVisible();
    await expect(
      blockRow(authedPage, 'byCategory').getByRole('button', { name: /Subir/ }),
    ).toBeDisabled();
    await expect(
      blockRow(authedPage, 'recent').getByRole('button', { name: /Bajar/ }),
    ).toBeDisabled();
    await expect(
      blockRow(authedPage, 'pace').getByRole('button', { name: /Subir/ }),
    ).toBeEnabled();
    await expect(
      blockRow(authedPage, 'pace').getByRole('button', { name: /Bajar/ }),
    ).toBeEnabled();
  });

  test('RNF-06 reordenar los bloques con el teclado se refleja en el Inicio', async ({
    authedPage,
  }) => {
    await seedData(authedPage);
    await authedPage.goto('/ajustes/inicio');
    await expect(blockRow(authedPage, 'pace')).toBeVisible();

    // "Subir" on Ritmo del gasto, with the keyboard alone.
    await blockRow(authedPage, 'pace').getByRole('button', { name: /Subir/ }).focus();
    await authedPage.keyboard.press('Enter');
    await expect
      .poll(() => savedReleasedOrder(authedPage), { timeout: 10_000 })
      .toEqual(['pace', 'byCategory', 'balances', 'recent']);

    // "Bajar" on the last-but-one block.
    await blockRow(authedPage, 'balances').getByRole('button', { name: /Bajar/ }).focus();
    await authedPage.keyboard.press('Enter');
    await expect
      .poll(() => savedReleasedOrder(authedPage), { timeout: 10_000 })
      .toEqual(['pace', 'byCategory', 'recent', 'balances']);

    await openInicio(authedPage);
    await expect
      .poll(() => inicioOrder(authedPage), { timeout: 10_000 })
      .toEqual(['pace', 'byCategory', 'recent', 'balances']);
  });

  test('RNF-06 /ajustes/inicio se usa con el teclado y no tiene fallas serias de accesibilidad', async ({
    authedPage,
  }) => {
    await authedPage.goto('/ajustes/inicio');
    await expect(blockRow(authedPage, 'pace')).toBeVisible();
    await expectNoBlockingViolations(authedPage);

    // Every control has an accessible name: the buttons say which block they move.
    const up = blockRow(authedPage, 'pace').getByRole('button', { name: /Subir/ });
    await up.focus();
    await expect(up).toBeFocused();
    await expect(up).toHaveAccessibleName(/Ritmo del gasto/);

    // The visibility is operated with the keyboard.
    const toggle = visibilityOf(authedPage, 'pace');
    await toggle.focus();
    await expect(toggle).toBeFocused();
    await authedPage.keyboard.press('Space');
    await expect
      .poll(async () => (await getBlocks(authedPage)).find((b) => b.key === 'pace')?.visible, {
        timeout: 10_000,
      })
      .toBe(false);
  });
});
