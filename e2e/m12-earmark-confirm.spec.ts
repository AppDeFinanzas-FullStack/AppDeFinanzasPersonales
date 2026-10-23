import { randomUUID } from 'node:crypto';

import type { Page } from '@playwright/test';

import { expect, test } from './fixtures/auth.js';

interface CategoryNode {
  id: string;
  name: string;
  kind: string;
  status: string;
  children: CategoryNode[];
}

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

function flatten(nodes: CategoryNode[]): CategoryNode[] {
  return nodes.flatMap((n) => [n, ...flatten(n.children)]);
}

async function createAccount(
  page: Page,
  name: string,
  initialBalance: string,
  type: 'cash' | 'bank' | 'savings' = 'cash',
): Promise<string> {
  const id = randomUUID();
  const res = await page.request.post('/api/accounts', {
    data: {
      id,
      type,
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

async function createGoal(page: Page, name: string, target: string): Promise<string> {
  const id = randomUUID();
  const res = await page.request.post('/api/goals', {
    data: { id, name, target, currencyCode: 'BOB', icon: 'plane', color: 'blue' },
  });
  expect(res.status()).toBe(201);
  return id;
}

async function earmark(
  page: Page,
  goalId: string,
  accountId: string,
  amount: string,
): Promise<void> {
  const res = await page.request.post(`/api/goals/${goalId}/earmarks`, {
    data: { id: randomUUID(), accountId, amount },
  });
  expect(res.ok()).toBe(true);
}

async function progressOf(page: Page, goalId: string): Promise<number> {
  const res = await page.request.get(`/api/goals/${goalId}`);
  expect(res.ok()).toBe(true);
  return Number(((await res.json()) as { progress: string }).progress);
}

async function firstExpenseCategory(page: Page): Promise<string> {
  const res = await page.request.get('/api/categories?kind=expense&status=active');
  expect(res.ok()).toBe(true);
  const found = flatten((await res.json()) as CategoryNode[]).find(
    (n) => n.kind === 'expense' && n.status === 'active',
  );
  expect(found).toBeDefined();
  return found?.name ?? '';
}

async function fillExpense(page: Page, amount: string): Promise<void> {
  const category = await firstExpenseCategory(page);
  await page.goto('/registrar');
  await page.getByLabel('Monto', { exact: true }).fill(amount);
  await page
    .getByRole('button', { name: new RegExp(category) })
    .first()
    .click();
}

test.describe('TASK-192 confirmación de apartados', () => {
  test('RF-M12-05 gasto que toca dinero apartado: pregunta y, al confirmar, los apartados quedan en 200', async ({
    authedPage,
  }) => {
    const bank = await createAccount(authedPage, 'Banco', '4800.00', 'bank');
    const goalId = await createGoal(authedPage, 'Viaje', '3000.00');
    await earmark(authedPage, goalId, bank, '300.00');
    await fillExpense(authedPage, '4600');
    await authedPage.getByRole('button', { name: 'Guardar', exact: true }).click();
    const dialog = authedPage.getByRole('dialog');
    await expect(dialog).toBeVisible();
    await expect(dialog.getByText(/usa .*apartad/i)).toBeVisible();
    await expect(dialog.getByText(/100,00/).first()).toBeVisible();
    await expect(dialog.getByText(/Viaje/).first()).toBeVisible();
    await dialog.getByRole('button', { name: /confirmar/i }).click();
    await expect(authedPage.getByRole('dialog')).toHaveCount(0);
    expect(await progressOf(authedPage, goalId)).toBe(200);
  });

  test('EC-M7-03 al cancelar, el formulario de Registrar queda intacto', async ({ authedPage }) => {
    const bank = await createAccount(authedPage, 'Banco', '4800.00', 'bank');
    const goalId = await createGoal(authedPage, 'Viaje', '3000.00');
    await earmark(authedPage, goalId, bank, '300.00');
    await fillExpense(authedPage, '4600');
    await authedPage.getByRole('button', { name: 'Guardar', exact: true }).click();
    const dialog = authedPage.getByRole('dialog');
    await expect(dialog).toBeVisible();
    await dialog.getByRole('button', { name: /cancelar/i }).click();
    await expect(authedPage.getByRole('dialog')).toHaveCount(0);
    await expect(authedPage.getByLabel('Monto', { exact: true })).toHaveValue(/4\.?600/);
    expect(await progressOf(authedPage, goalId)).toBe(300);
  });

  test('RF-M7-14 salida de la cuenta dedicada sin confirmación: aviso y el progreso baja', async ({
    authedPage,
  }) => {
    const savings = await createAccount(authedPage, 'Ahorro', '850.00', 'savings');
    const goalId = await createGoal(authedPage, 'Viaje', '3000.00');
    const dedicated = await authedPage.request.post(`/api/goals/${goalId}/dedicate`, {
      data: { accountId: savings },
    });
    expect(dedicated.ok()).toBe(true);
    expect(await progressOf(authedPage, goalId)).toBe(850);
    await fillExpense(authedPage, '100');
    await expect(authedPage.getByText('Esto resta a tu meta Viaje')).toBeVisible();
    await authedPage.getByRole('button', { name: 'Guardar', exact: true }).click();
    await expect(authedPage.getByRole('dialog')).toHaveCount(0);
    await expect.poll(() => progressOf(authedPage, goalId)).toBe(750);
  });

  test('RF-M12-05 el aviso de cuenta dedicada no pide confirmación al guardar', async ({
    authedPage,
  }) => {
    const savings = await createAccount(authedPage, 'Ahorro', '850.00', 'savings');
    const goalId = await createGoal(authedPage, 'Viaje', '3000.00');
    const dedicated = await authedPage.request.post(`/api/goals/${goalId}/dedicate`, {
      data: { accountId: savings },
    });
    expect(dedicated.ok()).toBe(true);
    await fillExpense(authedPage, '100');
    await authedPage.getByRole('button', { name: 'Guardar', exact: true }).click();
    await expect(authedPage.getByRole('dialog')).toHaveCount(0);
    await expect(authedPage.getByText(/guardado/i).first()).toBeVisible();
  });

  test('RF-M4-10 el desglose muestra la línea Apartado para metas', async ({ authedPage }) => {
    const bank = await createAccount(authedPage, 'Banco', '4800.00', 'bank');
    const goalId = await createGoal(authedPage, 'Viaje', '3000.00');
    await earmark(authedPage, goalId, bank, '300.00');
    await authedPage.goto('/cuentas');
    await expect(authedPage.getByText('Apartado para metas')).toBeVisible();
  });
});

async function categoryIdOf(page: Page, kind: 'expense' | 'income'): Promise<string> {
  const res = await page.request.get(`/api/categories?kind=${kind}&status=active`);
  expect(res.ok()).toBe(true);
  const found = flatten((await res.json()) as CategoryNode[]).find(
    (n) => n.kind === kind && n.status === 'active',
  );
  expect(found).toBeDefined();
  return found?.id ?? '';
}

async function createTransaction(
  page: Page,
  kind: 'expense' | 'income',
  accountId: string,
  amount: string,
): Promise<string> {
  const id = randomUUID();
  const res = await page.request.post('/api/transactions', {
    data: {
      kind,
      id,
      accountId,
      categoryId: await categoryIdOf(page, kind),
      amount,
      date: today(),
    },
  });
  expect(res.status()).toBe(201);
  return id;
}

function earmarkDialog(page: Page) {
  return page.getByRole('dialog').filter({ hasText: /usa .*apartad/i });
}

test.describe('TASK-192 confirmación de apartados en otros flujos', () => {
  test('RF-M12-05 editar un movimiento que deja el saldo bajo lo apartado pide confirmación', async ({
    authedPage,
  }) => {
    const bank = await createAccount(authedPage, 'Banco', '500.00', 'bank');
    const txId = await createTransaction(authedPage, 'expense', bank, '100');
    const goalId = await createGoal(authedPage, 'Viaje', '3000.00');
    await earmark(authedPage, goalId, bank, '400.00');
    await authedPage.goto(`/movimientos/${txId}`);
    await authedPage.getByRole('button', { name: 'Editar', exact: true }).click();
    await authedPage.getByLabel('Monto', { exact: true }).fill('200');
    await authedPage.getByRole('button', { name: 'Guardar cambios' }).click();
    const dialog = earmarkDialog(authedPage);
    await expect(dialog).toBeVisible();
    await dialog.getByRole('button', { name: /confirmar/i }).click();
    await expect(authedPage.getByRole('dialog')).toHaveCount(0);
    await expect.poll(() => progressOf(authedPage, goalId)).toBe(300);
  });

  test('RF-M12-05 eliminar un ingreso que deja el saldo bajo lo apartado pide confirmación', async ({
    authedPage,
  }) => {
    const bank = await createAccount(authedPage, 'Banco', '100.00', 'bank');
    const txId = await createTransaction(authedPage, 'income', bank, '500');
    const goalId = await createGoal(authedPage, 'Viaje', '3000.00');
    await earmark(authedPage, goalId, bank, '400.00');
    await authedPage.goto(`/movimientos/${txId}`);
    await authedPage.getByRole('button', { name: 'Eliminar', exact: true }).click();
    const dialog = earmarkDialog(authedPage);
    await expect(dialog).toBeVisible();
    await dialog.getByRole('button', { name: /confirmar/i }).click();
    await expect(authedPage.getByRole('dialog')).toHaveCount(0);
    await expect.poll(() => progressOf(authedPage, goalId)).toBe(100);
  });

  test('RF-M12-05 deshacer una eliminación que deja el saldo bajo lo apartado pide confirmación', async ({
    authedPage,
  }) => {
    const bank = await createAccount(authedPage, 'Banco', '500.00', 'bank');
    const txId = await createTransaction(authedPage, 'expense', bank, '100');
    const goalId = await createGoal(authedPage, 'Viaje', '3000.00');
    await authedPage.goto(`/movimientos/${txId}`);
    await authedPage.getByRole('button', { name: 'Eliminar', exact: true }).click();
    await expect(authedPage.getByText('Movimiento eliminado')).toBeVisible();
    await earmark(authedPage, goalId, bank, '500.00');
    await authedPage.getByRole('button', { name: 'Deshacer', exact: true }).click();
    const dialog = earmarkDialog(authedPage);
    await expect(dialog).toBeVisible();
    await dialog.getByRole('button', { name: /confirmar/i }).click();
    await expect(authedPage.getByRole('dialog')).toHaveCount(0);
    await expect.poll(() => progressOf(authedPage, goalId)).toBe(400);
  });

  test('EC-M12-07 un ajuste negativo de saldo bajo lo apartado pide confirmación', async ({
    authedPage,
  }) => {
    const bank = await createAccount(authedPage, 'Banco', '500.00', 'bank');
    const goalId = await createGoal(authedPage, 'Viaje', '3000.00');
    await earmark(authedPage, goalId, bank, '400.00');
    await authedPage.goto(`/cuentas/${bank}?ajustar=1`);
    await authedPage.getByLabel('Saldo real').fill('100');
    await authedPage.getByRole('button', { name: 'Ajustar', exact: true }).click();
    const dialog = earmarkDialog(authedPage);
    await expect(dialog).toBeVisible();
    await dialog.getByRole('button', { name: /confirmar/i }).click();
    await expect(authedPage.getByRole('dialog')).toHaveCount(0);
    await expect.poll(() => progressOf(authedPage, goalId)).toBe(100);
  });
});
