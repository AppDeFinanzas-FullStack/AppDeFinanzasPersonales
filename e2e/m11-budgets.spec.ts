import { randomUUID } from 'node:crypto';

import type { Page } from '@playwright/test';

import { expect, test } from './fixtures/auth.js';

type Json = Record<string, unknown>;

function today(): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/La_Paz' }).format(new Date());
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
      initialBalanceDate: today(),
      color: 'teal',
      icon: 'wallet',
    },
  });
  expect(res.status()).toBe(201);
  return id;
}

interface CategoryNode {
  id: string;
  kind: string;
  status: string;
  isSystem?: boolean;
  children: CategoryNode[];
}

function flatten(nodes: CategoryNode[]): CategoryNode[] {
  return nodes.flatMap((node) => [node, ...flatten(node.children)]);
}

async function expenseCategoryId(page: Page): Promise<string> {
  const res = await page.request.get('/api/categories?kind=expense&status=active');
  expect(res.ok()).toBe(true);
  const node = flatten((await res.json()) as CategoryNode[]).find(
    (n) => n.kind === 'expense' && n.status === 'active' && n.isSystem !== true,
  );
  expect(node).toBeDefined();
  return node?.id ?? '';
}

async function recordExpense(page: Page, accountId: string, amount: string): Promise<void> {
  const res = await page.request.post('/api/transactions', {
    data: {
      kind: 'expense',
      id: randomUUID(),
      accountId,
      categoryId: await expenseCategoryId(page),
      amount,
      date: today(),
    },
  });
  expect(res.status()).toBe(201);
}

/** A general budget in BOB, created through the API (plan §4.11.2). */
async function createGeneralBudget(page: Page, amount: string): Promise<string> {
  const id = randomUUID();
  const res = await page.request.post('/api/budgets', {
    data: { id, scope: 'general', amount, currencyCode: 'BOB' },
  });
  expect(res.status()).toBe(201);
  return id;
}

/**
 * A carryover comes only from a closed period decided days ago, so the reads of the budgets are
 * served with the period in course changed to reach the state each case describes.
 */
async function overrideCurrent(page: Page, current: Json): Promise<void> {
  await page.route(/\/api\/budgets(\/[^/?]+)?(\?.*)?$/, async (route) => {
    if (route.request().method() !== 'GET') {
      await route.continue();
      return;
    }
    const response = await route.fetch();
    const body = (await response.json()) as Json & { items?: Json[] };
    const patch = (budget: Json): Json => ({
      ...budget,
      current: { ...(budget['current'] as Json), ...current },
    });
    const json = Array.isArray(body.items) ? { items: body.items.map(patch) } : patch(body);
    await route.fulfill({ response, json });
  });
}

function currentMonthPattern(): RegExp {
  const now = new Date();
  const long = new Intl.DateTimeFormat('es-BO', { month: 'long' }).format(now);
  const short = long.slice(0, 3);
  const mm = String(now.getMonth() + 1).padStart(2, '0');
  return new RegExp(`${long}|\\b${short}\\b|\\d{1,2}/${mm}`, 'i');
}

async function openActions(page: Page): Promise<void> {
  await page
    .getByRole('button', { name: /acciones|opciones|más/i })
    .first()
    .click();
}

test.describe('TASK-205 lista y detalle de presupuestos', () => {
  test('TASK-205 la lista muestra la barra y el período visible', async ({ authedPage }) => {
    await createGeneralBudget(authedPage, '1000.00');
    await authedPage.goto('/presupuestos');
    await expect(authedPage.getByRole('progressbar').first()).toBeVisible();
    await expect(authedPage.getByText(/1\.000,00/).first()).toBeVisible();
    await expect(authedPage.getByText(currentMonthPattern()).first()).toBeVisible();
  });

  test('TASK-205 seguir el período: el detalle muestra la marca "hoy deberías llevar" y el ritmo', async ({
    authedPage,
  }) => {
    const id = await createGeneralBudget(authedPage, '1000.00');
    await authedPage.goto(`/presupuestos/${id}`);
    await expect(authedPage.getByRole('progressbar').first()).toBeVisible();
    await expect(authedPage.getByText(/hoy deberías llevar/i).first()).toBeVisible();
    await expect(authedPage.getByText(/puedes gastar/i).first()).toBeVisible();
  });

  test('RF-M11-05 se ve el desglose del arrastre con los ajustes tardíos', async ({
    authedPage,
  }) => {
    const id = await createGeneralBudget(authedPage, '1000.00');
    await overrideCurrent(authedPage, {
      spent: '0.00',
      carryover: '-200.00',
      available: '850.00',
      lateAdjustments: [
        { sourceLabel: 'Ajuste por movimientos tardíos de septiembre', amount: '50.00' },
      ],
      pace: { kind: 'daily', amount: '28.33', days: 30 },
    });
    await authedPage.goto(`/presupuestos/${id}`);
    await expect(authedPage.getByText(/1\.000,00/).first()).toBeVisible();
    await expect(authedPage.getByText(/200,00/).first()).toBeVisible();
    await expect(authedPage.getByText(/850,00/).first()).toBeVisible();
    await expect(
      authedPage.getByText(/ajuste por movimientos tardíos de septiembre/i).first(),
    ).toBeVisible();
    await expect(authedPage.getByText(/50,00/).first()).toBeVisible();
  });

  test('EC-M11-01 un período que empieza superado muestra "Superado por X" desde el inicio', async ({
    authedPage,
  }) => {
    const id = await createGeneralBudget(authedPage, '1000.00');
    await overrideCurrent(authedPage, {
      spent: '0.00',
      carryover: '-1200.00',
      available: '-200.00',
      lateAdjustments: [],
      pace: { kind: 'exceeded', amount: '200.00' },
    });
    await authedPage.goto(`/presupuestos/${id}`);
    await expect(authedPage.getByText(/superado por.*200,00/i).first()).toBeVisible();
    await expect(authedPage.getByText(/puedes gastar/i)).toHaveCount(0);
    const value = await authedPage.getByRole('progressbar').first().getAttribute('aria-valuenow');
    expect(Number(value)).toBeGreaterThanOrEqual(100);
  });

  test('RF-M11-05 en la lista, un período que empieza superado se muestra superado', async ({
    authedPage,
  }) => {
    await createGeneralBudget(authedPage, '1000.00');
    await overrideCurrent(authedPage, {
      spent: '0.00',
      carryover: '-1200.00',
      available: '-200.00',
      lateAdjustments: [],
      pace: { kind: 'exceeded', amount: '200.00' },
    });
    await authedPage.goto('/presupuestos');
    await expect(authedPage.getByText(/superado por.*200,00/i).first()).toBeVisible();
  });

  test('RF-M11-14 un presupuesto superado sigue contando gastos y se muestra superado', async ({
    authedPage,
  }) => {
    const accountId = await createAccount(authedPage, 'Efectivo', '1000.00');
    const id = await createGeneralBudget(authedPage, '100.00');
    await recordExpense(authedPage, accountId, '120.00');
    await recordExpense(authedPage, accountId, '30.00');
    await authedPage.goto(`/presupuestos/${id}`);
    await expect(authedPage.getByText(/150,00/).first()).toBeVisible();
    await expect(authedPage.getByText(/superado por.*50,00/i).first()).toBeVisible();
  });

  test('RF-M11-12 la confirmación de reiniciar el arrastre muestra el monto', async ({
    authedPage,
  }) => {
    const id = await createGeneralBudget(authedPage, '1000.00');
    await overrideCurrent(authedPage, {
      spent: '0.00',
      carryover: '-150.00',
      available: '850.00',
      lateAdjustments: [],
      pace: { kind: 'daily', amount: '28.33', days: 30 },
    });
    await authedPage.goto(`/presupuestos/${id}`);
    await openActions(authedPage);
    await authedPage.getByRole('menuitem', { name: /reiniciar arrastre/i }).click();
    const dialog = authedPage.getByRole('dialog');
    await expect(dialog).toBeVisible();
    await expect(dialog.getByText(/150,00/).first()).toBeVisible();

    const reset = authedPage.waitForResponse(
      (r) =>
        r.url().endsWith(`/api/budgets/${id}/reset-carryover`) && r.request().method() === 'POST',
    );
    await dialog.getByRole('button', { name: /reiniciar|confirmar/i }).click();
    expect((await reset).ok()).toBe(true);
  });

  test('TASK-205 pausar y reanudar cambian el estado del presupuesto', async ({ authedPage }) => {
    const id = await createGeneralBudget(authedPage, '1000.00');
    await authedPage.goto(`/presupuestos/${id}`);
    await openActions(authedPage);
    await authedPage.getByRole('menuitem', { name: /pausar/i }).click();
    await expect(authedPage.getByText(/pausado/i).first()).toBeVisible();

    await openActions(authedPage);
    await authedPage.getByRole('menuitem', { name: /reanudar/i }).click();
    await expect(authedPage.getByText(/activo/i).first()).toBeVisible();
    await expect(authedPage.getByText(/pausado/i)).toHaveCount(0);
  });

  test('TASK-205 eliminar pide confirmación y quita el presupuesto', async ({ authedPage }) => {
    const id = await createGeneralBudget(authedPage, '1000.00');
    await authedPage.goto(`/presupuestos/${id}`);
    await openActions(authedPage);
    await authedPage.getByRole('menuitem', { name: /eliminar/i }).click();
    const dialog = authedPage.getByRole('dialog');
    await expect(dialog).toBeVisible();
    await dialog.getByRole('button', { name: /eliminar/i }).click();
    await expect(authedPage).toHaveURL(/\/presupuestos$/);
    const res = await authedPage.request.get(`/api/budgets/${id}`);
    expect(res.status()).toBe(404);
  });
});
