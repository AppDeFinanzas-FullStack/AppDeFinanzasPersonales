import { randomUUID } from 'node:crypto';

import type { Page } from '@playwright/test';

import { expect, test } from './fixtures/auth.js';

interface CategoryNode {
  id: string;
  kind: string;
  name: string;
  status: string;
  children: CategoryNode[];
}

const BOLIVIA_OFFSET_MS = 4 * 60 * 60 * 1000;

const pad = (n: number): string => String(n).padStart(2, '0');

/** Today in Bolivia (UTC-4) as `{ y, m, d }`. */
function today(): { y: number; m: number; d: number } {
  const now = new Date(Date.now() - BOLIVIA_OFFSET_MS);
  return { y: now.getUTCFullYear(), m: now.getUTCMonth() + 1, d: now.getUTCDate() };
}

function todayText(): string {
  const t = today();
  return `${t.y}-${pad(t.m)}-${pad(t.d)}`;
}

/** First day of the previous calendar month. */
function previousMonthStart(): string {
  const t = today();
  const y = t.m === 1 ? t.y - 1 : t.y;
  const m = t.m === 1 ? 12 : t.m - 1;
  return `${y}-${pad(m)}-01`;
}

function flatten(nodes: CategoryNode[]): CategoryNode[] {
  return nodes.flatMap((n) => [n, ...flatten(n.children)]);
}

async function createAccount(page: Page, name: string, initialBalance: string): Promise<string> {
  const id = randomUUID();
  const res = await page.request.post('/api/accounts', {
    data: {
      id,
      type: 'cash',
      name,
      currencyCode: 'BOB',
      initialBalance,
      initialBalanceDate: previousMonthStart(),
      color: 'teal',
      icon: 'wallet',
    },
  });
  expect(res.status()).toBe(201);
  return id;
}

async function categoryId(page: Page, kind: 'expense' | 'income'): Promise<string> {
  const res = await page.request.get(`/api/categories?kind=${kind}&status=active`);
  expect(res.ok()).toBe(true);
  const nodes = flatten((await res.json()) as CategoryNode[]);
  const found = nodes.find((n) => n.kind === kind && n.status === 'active');
  expect(found).toBeDefined();
  return found?.id ?? '';
}

async function record(
  page: Page,
  kind: 'expense' | 'income',
  accountId: string,
  amount: string,
  date: string,
): Promise<void> {
  const res = await page.request.post('/api/transactions', {
    data: {
      kind,
      id: randomUUID(),
      accountId,
      categoryId: await categoryId(page, kind),
      amount,
      date,
    },
  });
  expect(res.status()).toBe(201);
}

test.describe('TASK-147 Inicio, selector de mes y tarjetas', () => {
  test('EC-M8-01 sin cuentas, el Inicio invita a crear la primera', async ({ authedPage }) => {
    await authedPage.goto('/');
    await expect(authedPage.getByRole('heading', { name: 'Crea tu primera cuenta' })).toBeVisible();
    await expect(authedPage.getByRole('button', { name: 'Crear cuenta' })).toBeVisible();
  });

  test('EC-M8-01 al crear la primera cuenta aparecen las tarjetas', async ({ authedPage }) => {
    await authedPage.goto('/');
    await authedPage.getByLabel('Nombre').fill('Efectivo');
    await authedPage.getByLabel('Saldo actual').fill('100');
    await authedPage.getByRole('button', { name: 'Crear cuenta' }).click();
    await expect(authedPage.getByText('Gastos', { exact: true }).first()).toBeVisible();
    await expect(authedPage.getByRole('heading', { name: 'Crea tu primera cuenta' })).toHaveCount(
      0,
    );
  });

  test('EC-M8-02 en un mes vacío las tarjetas muestran 0 y la tasa de ahorro no aparece', async ({
    authedPage,
  }) => {
    await createAccount(authedPage, 'Efectivo', '0');
    await authedPage.goto('/');
    await expect(authedPage.getByText('Ingresos', { exact: true }).first()).toBeVisible();
    await expect(authedPage.getByText('Gastos', { exact: true }).first()).toBeVisible();
    await expect(authedPage.getByText('Balance', { exact: true }).first()).toBeVisible();
    await expect(authedPage.getByText(/0,00/).first()).toBeVisible();
    await expect(authedPage.getByText(/tasa de ahorro/i)).toHaveCount(0);
  });

  test('RF-M8-03 la tasa de ahorro aparece con ingresos y balance positivo', async ({
    authedPage,
  }) => {
    const account = await createAccount(authedPage, 'Efectivo', '0');
    await record(authedPage, 'income', account, '100', todayText());
    await record(authedPage, 'expense', account, '40', todayText());
    await authedPage.goto('/');
    await expect(authedPage.getByText(/tasa de ahorro/i).first()).toBeVisible();
    await expect(authedPage.getByText(/60\s?%/).first()).toBeVisible();
  });

  test('RF-M8-03 la tasa de ahorro se oculta con balance negativo', async ({ authedPage }) => {
    const account = await createAccount(authedPage, 'Efectivo', '500');
    await record(authedPage, 'income', account, '10', todayText());
    await record(authedPage, 'expense', account, '40', todayText());
    await authedPage.goto('/');
    await expect(authedPage.getByText('Gastos', { exact: true }).first()).toBeVisible();
    await expect(authedPage.getByText(/tasa de ahorro/i)).toHaveCount(0);
  });

  test('RF-M8-01 el selector no ofrece meses futuros', async ({ authedPage }) => {
    await createAccount(authedPage, 'Efectivo', '0');
    await authedPage.goto('/');
    await expect(authedPage.getByRole('button', { name: 'Mes siguiente' })).toBeDisabled();
    await expect(authedPage.getByRole('button', { name: 'Mes anterior' })).toBeVisible();
  });

  test('RF-M8-04 una variación de gastos positiva se muestra en rojo con texto accesible', async ({
    authedPage,
  }) => {
    const account = await createAccount(authedPage, 'Efectivo', '500');
    await record(authedPage, 'expense', account, '10', previousMonthStart());
    await record(authedPage, 'expense', account, '20', todayText());
    await authedPage.goto('/');
    const variation = authedPage.getByText(/\+100\s?%/).first();
    await expect(variation).toBeVisible();
    const rgb = await variation.evaluate((el) => getComputedStyle(el).color);
    const [r = 0, g = 0, b = 0] = (rgb.match(/\d+(\.\d+)?/g) ?? []).map(Number);
    expect(r).toBeGreaterThan(g);
    expect(r).toBeGreaterThan(b);
    // The meaning does not depend on the color alone.
    const card = authedPage.locator('section, article, div').filter({ has: variation }).last();
    await expect(card).toContainText(/sub[ií]|aument|más que/i);
  });

  test('RF-M8-11 Registro rápido en menos de 10 segundos: el Inicio refleja el gasto', async ({
    authedPage,
  }) => {
    await createAccount(authedPage, 'Efectivo', '100');
    await authedPage.goto('/');
    await expect(authedPage.getByText('Gastos', { exact: true }).first()).toBeVisible();

    await authedPage.goto('/registrar');
    await authedPage.getByLabel('Monto').fill('35');
    await authedPage.getByRole('button', { name: 'Supermercado' }).click();
    await authedPage.getByRole('button', { name: 'Guardar', exact: true }).click();
    await expect(authedPage.getByText(/guardado/i).first()).toBeVisible();

    await authedPage.getByRole('navigation').first().getByRole('link', { name: 'Inicio' }).click();
    await expect(authedPage.getByText(/35,00/).first()).toBeVisible();
  });
});
