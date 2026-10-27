import { randomUUID } from 'node:crypto';

import type { Locator, Page } from '@playwright/test';

import { expect, test } from './fixtures/auth.js';

interface RatesCurrent {
  inUse: { kind: string; value: string | null };
  base: string;
  other: string;
}

interface CurrencyItem {
  code: string;
  symbol: string;
  rate: string;
  status: string;
}

interface CategoryNode {
  id: string;
  kind: string;
  status: string;
  children: CategoryNode[];
}

interface TransactionDetail {
  id: string;
  date: string;
  entries: { accountId: string; amount: string; currencyCode: string }[];
  rateUsdBob?: string | null;
  rateCurBob: string;
}

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

async function getRates(page: Page): Promise<RatesCurrent> {
  const res = await page.request.get('/api/rates/current');
  expect(res.ok()).toBe(true);
  return (await res.json()) as RatesCurrent;
}

async function getCurrencies(page: Page): Promise<CurrencyItem[]> {
  const res = await page.request.get('/api/currencies');
  expect(res.ok()).toBe(true);
  return ((await res.json()) as { items: CurrencyItem[] }).items;
}

async function setManual(page: Page, value: string): Promise<void> {
  const res = await page.request.put('/api/fx/manual', { data: { value } });
  expect(res.status()).toBe(204);
}

async function addCurrency(page: Page, code: string, symbol: string, rate: string): Promise<void> {
  const res = await page.request.post('/api/currencies', { data: { code, symbol, rate } });
  expect(res.status()).toBe(201);
}

async function deactivateCurrency(page: Page, code: string): Promise<void> {
  const res = await page.request.post(`/api/currencies/${code}/deactivate`);
  expect(res.status()).toBe(204);
}

/**
 * A user with a cash account of Bs 500 and an expense of Bs 40 saved while a manual dollar of
 * Bs 10 is active: the account ends with Bs 460, which is $ 46,00 at that dollar.
 */
async function seedBolivianAccount(page: Page): Promise<{ accountId: string; expenseId: string }> {
  await setManual(page, '10');
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
  const expenseId = randomUUID();
  const expense = await page.request.post('/api/transactions', {
    data: {
      kind: 'expense',
      id: expenseId,
      accountId,
      categoryId: category?.id,
      amount: '40',
      date: todayText(),
    },
  });
  expect(expense.status()).toBe(201);
  return { accountId, expenseId };
}

async function getTransaction(page: Page, id: string): Promise<TransactionDetail> {
  const res = await page.request.get(`/api/transactions/${id}`);
  expect(res.ok()).toBe(true);
  const body = (await res.json()) as TransactionDetail;
  // Only what was recorded: the amount in the base currency follows the base on purpose.
  return {
    id: body.id,
    date: body.date,
    entries: body.entries,
    rateUsdBob: body.rateUsdBob ?? null,
    rateCurBob: body.rateCurBob,
  };
}

/** The base currency control of `/ajustes/monedas`: a native select or a custom one. */
function baseSelect(page: Page): Locator {
  return page.getByRole('combobox', { name: /moneda base/i });
}

async function isNativeSelect(control: Locator): Promise<boolean> {
  return control.evaluate((el) => el.tagName === 'SELECT');
}

/** The text of every option the base currency control offers. */
async function baseOptions(page: Page): Promise<string[]> {
  const control = baseSelect(page);
  if (await isNativeSelect(control)) {
    return control.locator('option').allTextContents();
  }
  await control.click();
  const texts = await page.getByRole('option').allTextContents();
  await page.keyboard.press('Escape');
  return texts;
}

async function chooseBase(page: Page, code: string): Promise<void> {
  const control = baseSelect(page);
  if (await isNativeSelect(control)) {
    const value = await control.locator('option').evaluateAll((options, wanted: string) => {
      const found = (options as HTMLOptionElement[]).find(
        (option) => option.value === wanted || (option.textContent ?? '').includes(wanted),
      );
      return found?.value ?? null;
    }, code);
    expect(value).not.toBeNull();
    await control.selectOption(value);
    return;
  }
  await control.click();
  await page.getByRole('option', { name: new RegExp(code) }).click();
}

/** What the base currency control shows as chosen. */
async function selectedBase(page: Page): Promise<string> {
  const control = baseSelect(page);
  if (await isNativeSelect(control)) {
    return control.evaluate(
      (el) => (el as HTMLSelectElement).selectedOptions[0]?.textContent ?? '',
    );
  }
  return (await control.textContent()) ?? '';
}

async function openCurrencySettings(page: Page): Promise<void> {
  await page.goto('/ajustes/monedas');
  await expect(baseSelect(page)).toBeVisible();
}

async function resetSection(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'Restablecer valores por defecto' }).click();
  const dialog = page.getByRole('alertdialog');
  await expect(dialog).toBeVisible();
  await dialog.getByRole('button', { name: 'Restablecer', exact: true }).click();
  await expect(dialog).toBeHidden();
}

test.describe('TASK-154 Ajustes de monedas', () => {
  test('TASK-154 /ajustes lleva a /ajustes/monedas con la moneda base y el panel de tipo de cambio', async ({
    authedPage,
  }) => {
    await authedPage.goto('/ajustes');
    const main = authedPage.getByRole('main');
    await main.getByRole('link', { name: /Monedas y tipo de cambio/ }).click();
    await expect(authedPage).toHaveURL(/\/ajustes\/monedas$/);
    await expect(
      main.getByRole('heading', { level: 1, name: 'Monedas y tipo de cambio' }),
    ).toBeVisible();

    await expect(baseSelect(authedPage)).toBeVisible();
    // The same panel as /tipo-de-cambio: reference, manual value and added currencies.
    await expect(main.getByLabel('Referencia para convertir')).toBeVisible();
    await expect(main.getByLabel('Valor del dólar en Bs')).toBeVisible();
    await expect(main.getByRole('heading', { name: 'Monedas agregadas' })).toBeVisible();
    await expect(main.getByRole('button', { name: 'Agregar moneda' })).toBeVisible();
    await expect(
      main.getByRole('button', { name: 'Restablecer valores por defecto' }),
    ).toBeVisible();
  });

  test('TASK-154 la moneda base ofrece solo las monedas activas', async ({ authedPage }) => {
    await addCurrency(authedPage, 'EUR', '€', '11.20');
    await addCurrency(authedPage, 'GBP', '£', '13.50');
    await deactivateCurrency(authedPage, 'GBP');

    await openCurrencySettings(authedPage);
    const options = (await baseOptions(authedPage)).join(' | ');
    expect(options).toMatch(/BOB/);
    expect(options).toMatch(/USD/);
    expect(options).toMatch(/EUR/);
    expect(options).not.toMatch(/GBP/);
    await expect.poll(() => selectedBase(authedPage)).toMatch(/BOB/);
  });

  test('TASK-154 la lista de monedas dice cuáles están activas (status)', async ({
    authedPage,
  }) => {
    await addCurrency(authedPage, 'EUR', '€', '11.20');
    await addCurrency(authedPage, 'GBP', '£', '13.50');
    await deactivateCurrency(authedPage, 'GBP');

    const items = await getCurrencies(authedPage);
    expect(items.find((item) => item.code === 'EUR')).toMatchObject({
      symbol: '€',
      rate: '11.20',
      status: 'active',
    });
    expect(items.find((item) => item.code === 'GBP')).toMatchObject({
      symbol: '£',
      rate: '13.50',
      status: 'inactive',
    });
  });

  test('TASK-154 agregar una moneda desde el panel la suma a las opciones de la base', async ({
    authedPage,
  }) => {
    await openCurrencySettings(authedPage);
    await authedPage.getByRole('button', { name: 'Agregar moneda' }).click();
    const dialog = authedPage.getByRole('dialog');
    await dialog.getByLabel('Código').fill('EUR');
    await dialog.getByLabel('Símbolo').fill('€');
    await dialog.getByLabel('Valor en Bs').fill('11,20');
    await dialog.getByRole('button', { name: 'Agregar', exact: true }).click();
    await expect(dialog).toBeHidden();

    await expect(authedPage.getByTestId('currency-EUR')).toBeVisible();
    await expect.poll(async () => (await baseOptions(authedPage)).join(' | ')).toMatch(/EUR/);
  });

  test('RF-M3-11 cambiar la base a USD reexpresa los totales de Cuentas sin cambiar los movimientos', async ({
    authedPage,
  }) => {
    const { expenseId } = await seedBolivianAccount(authedPage);
    const recorded = await getTransaction(authedPage, expenseId);

    await authedPage.goto('/cuentas');
    await expect(authedPage.getByTestId('net-worth-base')).toHaveText(/Bs\s*460,00/);

    await openCurrencySettings(authedPage);
    await chooseBase(authedPage, 'USD');
    await expect
      .poll(async () => (await getRates(authedPage)).base, { timeout: 10_000 })
      .toBe('USD');

    await authedPage.goto('/cuentas');
    await expect(authedPage.getByTestId('net-worth-base')).toHaveText(/\$\s*46,00/);
    await expect(authedPage.getByText(/Equivale a Bs\s*460,00/)).toBeVisible();

    // The recorded movement keeps its amount, its date, its account and its rates.
    expect(await getTransaction(authedPage, expenseId)).toEqual(recorded);
  });

  test('RF-M3-11 cambiar la base a USD reexpresa los totales del Inicio y sus últimos movimientos', async ({
    authedPage,
  }) => {
    await seedBolivianAccount(authedPage);

    await authedPage.goto('/');
    const balances = authedPage.getByRole('region', { name: 'Saldos por cuenta' });
    await expect(balances).toContainText(/Bs\s*460,00/);

    await openCurrencySettings(authedPage);
    await chooseBase(authedPage, 'USD');
    await expect
      .poll(async () => (await getRates(authedPage)).base, { timeout: 10_000 })
      .toBe('USD');

    await authedPage.goto('/');
    await expect(authedPage.getByText('Saldos al día de hoy').first()).toBeVisible();
    await expect(balances.getByText(/\$\s*46,00/).first()).toBeVisible();
    // The whole Inicio keeps loading with a base other than Bs.
    await expect(authedPage.getByText(/No pudimos cargar el Inicio/)).toHaveCount(0);
    const recent = authedPage.getByRole('region', { name: 'Últimos movimientos' });
    await expect(recent).toBeVisible();
    await expect(recent.getByText(/\$\s*4,00/)).toBeVisible();
  });

  test('RF-M3-11 la base elegida queda guardada y se puede volver a Bs', async ({ authedPage }) => {
    await seedBolivianAccount(authedPage);
    await openCurrencySettings(authedPage);
    await chooseBase(authedPage, 'USD');
    await expect
      .poll(async () => (await getRates(authedPage)).base, { timeout: 10_000 })
      .toBe('USD');

    await openCurrencySettings(authedPage);
    await expect.poll(() => selectedBase(authedPage)).toMatch(/USD/);

    await chooseBase(authedPage, 'BOB');
    await expect
      .poll(async () => (await getRates(authedPage)).base, { timeout: 10_000 })
      .toBe('BOB');
    await authedPage.goto('/cuentas');
    await expect(authedPage.getByTestId('net-worth-base')).toHaveText(/Bs\s*460,00/);
  });

  test('RF-M3-11 una moneda agregada puede ser la base', async ({ authedPage }) => {
    await addCurrency(authedPage, 'EUR', '€', '11.20');
    await openCurrencySettings(authedPage);
    await chooseBase(authedPage, 'EUR');
    await expect
      .poll(async () => (await getRates(authedPage)).base, { timeout: 10_000 })
      .toBe('EUR');
  });

  test('RF-M3-11 cambiar el valor manual desde el panel reexpresa los totales sin tocar los movimientos', async ({
    authedPage,
  }) => {
    const { expenseId } = await seedBolivianAccount(authedPage);
    const recorded = await getTransaction(authedPage, expenseId);
    const res = await authedPage.request.patch('/api/fx-settings', {
      data: { baseCurrency: 'USD' },
    });
    expect(res.status()).toBe(204);
    await authedPage.goto('/cuentas');
    await expect(authedPage.getByTestId('net-worth-base')).toHaveText(/\$\s*46,00/);

    await openCurrencySettings(authedPage);
    await authedPage.getByLabel('Valor del dólar en Bs').fill('20');
    await authedPage.getByRole('button', { name: 'Usar este valor' }).click();
    await expect
      .poll(async () => (await getRates(authedPage)).inUse.value, { timeout: 10_000 })
      .toBe('20.00');

    await authedPage.goto('/cuentas');
    await expect(authedPage.getByTestId('net-worth-base')).toHaveText(/\$\s*23,00/);
    expect(await getTransaction(authedPage, expenseId)).toEqual(recorded);
  });

  test('RF-M3-03 por defecto la referencia es la mediana del paralelo', async ({ authedPage }) => {
    await openCurrencySettings(authedPage);
    await expect(authedPage.getByLabel('Referencia para convertir')).toHaveValue('parallel_median');
    expect((await getRates(authedPage)).inUse.kind).toBe('parallel_median');
    await expect(authedPage.getByText(/Usando tu valor manual/)).toHaveCount(0);
  });

  test('RF-M3-03 el valor manual del panel tiene prioridad sobre la referencia elegida', async ({
    authedPage,
  }) => {
    await openCurrencySettings(authedPage);
    await authedPage.getByLabel('Valor del dólar en Bs').fill('10,25');
    await authedPage.getByRole('button', { name: 'Usar este valor' }).click();
    await expect(authedPage.getByText(/Usando tu valor manual/)).toBeVisible();
    await expect
      .poll(async () => (await getRates(authedPage)).inUse, { timeout: 10_000 })
      .toMatchObject({ kind: 'manual', value: '10.25' });

    // Choosing another reference does not displace the manual value.
    const res = await authedPage.request.patch('/api/fx-settings', {
      data: { usdReference: 'official' },
    });
    expect(res.status()).toBe(204);
    await authedPage.reload();
    await expect(authedPage.getByText(/Usando tu valor manual/)).toBeVisible();
    expect(await getRates(authedPage)).toMatchObject({
      inUse: { kind: 'manual', value: '10.25' },
    });
  });

  test('RF-M3-03 dejar de usar el valor manual devuelve la referencia elegida', async ({
    authedPage,
  }) => {
    const res = await authedPage.request.patch('/api/fx-settings', {
      data: { usdReference: 'official' },
    });
    expect(res.status()).toBe(204);
    await setManual(authedPage, '10');

    await openCurrencySettings(authedPage);
    await expect(authedPage.getByText(/Usando tu valor manual/)).toBeVisible();
    await authedPage.getByRole('button', { name: 'Dejar de usar el valor manual' }).click();
    await expect(authedPage.getByText(/Usando tu valor manual/)).toHaveCount(0);
    await expect
      .poll(async () => (await getRates(authedPage)).inUse.kind, { timeout: 10_000 })
      .toBe('official');
    await expect(authedPage.getByLabel('Referencia para convertir')).toHaveValue('official');
  });

  test('RF-M3-03 restablecer la sección vuelve a la mediana del paralelo y desactiva el valor manual', async ({
    authedPage,
  }) => {
    const res = await authedPage.request.patch('/api/fx-settings', {
      data: { usdReference: 'official' },
    });
    expect(res.status()).toBe(204);
    await setManual(authedPage, '10');

    await openCurrencySettings(authedPage);
    await expect(authedPage.getByText(/Usando tu valor manual/)).toBeVisible();
    await resetSection(authedPage);

    await expect(authedPage.getByText(/Usando tu valor manual/)).toHaveCount(0);
    await expect(
      authedPage.getByRole('button', { name: 'Dejar de usar el valor manual' }),
    ).toHaveCount(0);
    await expect(authedPage.getByLabel('Referencia para convertir')).toHaveValue('parallel_median');
    await expect
      .poll(async () => (await getRates(authedPage)).inUse.kind, { timeout: 10_000 })
      .toBe('parallel_median');
  });

  test('RF-M3-03 cancelar la confirmación no restablece la sección', async ({ authedPage }) => {
    await setManual(authedPage, '10');
    await openCurrencySettings(authedPage);

    await authedPage.getByRole('button', { name: 'Restablecer valores por defecto' }).click();
    const dialog = authedPage.getByRole('alertdialog');
    await expect(dialog).toBeVisible();
    await dialog.getByRole('button', { name: 'Cancelar' }).click();
    await expect(dialog).toBeHidden();

    await expect(authedPage.getByText(/Usando tu valor manual/)).toBeVisible();
    expect(await getRates(authedPage)).toMatchObject({ inUse: { kind: 'manual', value: '10.00' } });
  });

  test('RF-M3-11 restablecer la sección no cambia los movimientos registrados', async ({
    authedPage,
  }) => {
    const { expenseId } = await seedBolivianAccount(authedPage);
    const recorded = await getTransaction(authedPage, expenseId);

    await openCurrencySettings(authedPage);
    await resetSection(authedPage);
    await expect
      .poll(async () => (await getRates(authedPage)).inUse.kind, { timeout: 10_000 })
      .toBe('parallel_median');

    expect(await getTransaction(authedPage, expenseId)).toEqual(recorded);
  });
});
