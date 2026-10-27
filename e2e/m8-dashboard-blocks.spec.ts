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

function today(): { y: number; m: number; d: number } {
  const now = new Date(Date.now() - BOLIVIA_OFFSET_MS);
  return { y: now.getUTCFullYear(), m: now.getUTCMonth() + 1, d: now.getUTCDate() };
}

function todayText(): string {
  const t = today();
  return `${t.y}-${pad(t.m)}-${pad(t.d)}`;
}

function currentMonth(): string {
  const t = today();
  return `${t.y}-${pad(t.m)}`;
}

function previousMonthStart(): string {
  const t = today();
  const y = t.m === 1 ? t.y - 1 : t.y;
  const m = t.m === 1 ? 12 : t.m - 1;
  return `${y}-${pad(m)}-01`;
}

function flatten(nodes: CategoryNode[]): CategoryNode[] {
  return nodes.flatMap((n) => [n, ...flatten(n.children)]);
}

async function createAccount(
  page: Page,
  name: string,
  initialBalance: string,
  currencyCode: 'BOB' | 'USD' = 'BOB',
): Promise<string> {
  const id = randomUUID();
  const res = await page.request.post('/api/accounts', {
    data: {
      id,
      type: 'cash',
      name,
      currencyCode,
      initialBalance,
      initialBalanceDate: previousMonthStart(),
      color: 'teal',
      icon: 'wallet',
    },
  });
  expect(res.status()).toBe(201);
  return id;
}

async function firstCategory(page: Page, kind: 'expense' | 'income'): Promise<CategoryNode> {
  const res = await page.request.get(`/api/categories?kind=${kind}&status=active`);
  expect(res.ok()).toBe(true);
  const nodes = flatten((await res.json()) as CategoryNode[]);
  const found = nodes.find((n) => n.kind === kind && n.status === 'active');
  expect(found).toBeDefined();
  return found as CategoryNode;
}

async function recordExpense(page: Page, accountId: string, amount: string): Promise<CategoryNode> {
  const category = await firstCategory(page, 'expense');
  const res = await page.request.post('/api/transactions', {
    data: {
      kind: 'expense',
      id: randomUUID(),
      accountId,
      categoryId: category.id,
      amount,
      date: todayText(),
    },
  });
  expect(res.status()).toBe(201);
  return category;
}

test.describe('TASK-148 bloques del Inicio y navegación', () => {
  test('RF-M8-10 tocar la tarjeta Gastos abre Movimientos filtrado por gasto y ese mes', async ({
    authedPage,
  }) => {
    const account = await createAccount(authedPage, 'Efectivo', '500');
    await recordExpense(authedPage, account, '40');
    await authedPage.goto('/');
    await authedPage.getByRole('link', { name: /Gastos/ }).first().click();
    await expect(authedPage).toHaveURL(/\/movimientos\?/);
    const url = new URL(authedPage.url());
    expect(url.searchParams.get('kind')).toBe('expense');
    expect(url.searchParams.get('month')).toBe(currentMonth());
  });

  test('RF-M8-05 tocar una categoría filtra Movimientos por ella', async ({ authedPage }) => {
    const account = await createAccount(authedPage, 'Efectivo', '500');
    const category = await recordExpense(authedPage, account, '40');
    await authedPage.goto('/');
    await authedPage.getByRole('link', { name: new RegExp(category.name) }).first().click();
    await expect(authedPage).toHaveURL(/\/movimientos\?/);
    const url = new URL(authedPage.url());
    expect(url.searchParams.get('categoryId')).toBeTruthy();
    expect(url.searchParams.get('month')).toBe(currentMonth());
  });

  test('RF-M8-05 sin gastos, el bloque de categorías muestra el estado vacío con Registrar', async ({
    authedPage,
  }) => {
    await createAccount(authedPage, 'Efectivo', '100');
    await authedPage.goto('/');
    await expect(authedPage.getByText('Aún no tienes gastos este mes').first()).toBeVisible();
    await expect(authedPage.getByRole('link', { name: 'Registrar' }).first()).toBeVisible();
  });

  test('RF-M8-06 el bloque Ritmo del gasto se muestra en el Inicio', async ({ authedPage }) => {
    const account = await createAccount(authedPage, 'Efectivo', '500');
    await recordExpense(authedPage, account, '40');
    await authedPage.goto('/');
    await expect(authedPage.getByText(/Ritmo del gasto/i).first()).toBeVisible();
  });

  test('RF-M8-07 se ve la leyenda Saldos al día de hoy y Ver todas', async ({ authedPage }) => {
    await createAccount(authedPage, 'Efectivo', '100');
    await authedPage.goto('/');
    await expect(authedPage.getByText('Saldos al día de hoy').first()).toBeVisible();
    await expect(authedPage.getByRole('link', { name: 'Ver todas' }).first()).toBeVisible();
  });

  test('EC-M8-04 sin tasa, los saldos en otra moneda indican Sin tipo de cambio', async ({
    authedPage,
  }) => {
    await createAccount(authedPage, 'Dólares', '50', 'USD');
    await authedPage.goto('/');
    await expect(authedPage.getByText('Sin tipo de cambio').first()).toBeVisible();
  });
});
