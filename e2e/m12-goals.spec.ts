import { randomUUID } from 'node:crypto';

import type { Page } from '@playwright/test';

import { expect, test } from './fixtures/auth.js';

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

function monthsAhead(n: number): string {
  const d = new Date();
  d.setUTCDate(1);
  d.setUTCMonth(d.getUTCMonth() + n);
  return d.toISOString().slice(0, 10);
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

async function createGoal(
  page: Page,
  name: string,
  target: string,
  extra: Record<string, unknown> = {},
): Promise<string> {
  const id = randomUUID();
  const res = await page.request.post('/api/goals', {
    data: { id, name, target, currencyCode: 'BOB', icon: 'plane', color: 'blue', ...extra },
  });
  expect(res.status()).toBe(201);
  return id;
}

async function earmark(page: Page, goalId: string, accountId: string, amount: string): Promise<void> {
  const res = await page.request.post(`/api/goals/${goalId}/earmarks`, {
    data: { id: randomUUID(), accountId, amount },
  });
  expect(res.ok()).toBe(true);
}

/** The scenario "Progreso combinado": dedicated 850 + 200 in Banco + 150 in Efectivo. */
async function combinedGoal(page: Page, target: string, extra: Record<string, unknown> = {}): Promise<string> {
  const dedicated = await createAccount(page, 'Ahorro', '850.00', 'savings');
  const bank = await createAccount(page, 'Banco', '500.00', 'bank');
  const cash = await createAccount(page, 'Efectivo', '400.00');
  const goalId = await createGoal(page, 'Viaje', target, { dedicatedAccountId: dedicated, ...extra });
  await earmark(page, goalId, bank, '200.00');
  await earmark(page, goalId, cash, '150.00');
  return goalId;
}

test.describe('TASK-190 lista y detalle de metas', () => {
  test('RF-M12-02 la lista muestra la meta con su anillo de progreso y su estado', async ({
    authedPage,
  }) => {
    await combinedGoal(authedPage, '3000.00', { targetDate: monthsAhead(6) });
    await authedPage.goto('/metas');
    await expect(authedPage.getByRole('link', { name: /Viaje/ })).toBeVisible();
    await expect(authedPage.getByRole('progressbar').first()).toHaveAttribute(
      'aria-valuenow',
      '40',
    );
    await expect(authedPage.getByText(/en curso/i).first()).toBeVisible();
  });

  test('RF-M12-02 Progreso combinado: el detalle muestra Bs 1.200,00', async ({ authedPage }) => {
    const goalId = await combinedGoal(authedPage, '3000.00', { targetDate: monthsAhead(6) });
    await authedPage.goto(`/metas/${goalId}`);
    await expect(authedPage.getByText(/1\.200,00/).first()).toBeVisible();
  });

  test('RF-M12-07 el detalle muestra el progreso por cuenta', async ({ authedPage }) => {
    const goalId = await combinedGoal(authedPage, '3000.00', { targetDate: monthsAhead(6) });
    await authedPage.goto(`/metas/${goalId}`);
    await expect(authedPage.getByText('Ahorro').first()).toBeVisible();
    await expect(authedPage.getByText('Banco').first()).toBeVisible();
    await expect(authedPage.getByText('Efectivo').first()).toBeVisible();
    await expect(authedPage.getByText(/850,00/).first()).toBeVisible();
    await expect(authedPage.getByText(/200,00/).first()).toBeVisible();
    await expect(authedPage.getByText(/150,00/).first()).toBeVisible();
  });

  test('RF-M12-07 el historial muestra los apartados con su origen', async ({ authedPage }) => {
    const goalId = await combinedGoal(authedPage, '3000.00', { targetDate: monthsAhead(6) });
    await authedPage.goto(`/metas/${goalId}`);
    await expect(authedPage.getByText(/manual/i).first()).toBeVisible();
  });

  test('RF-M12-06 se ve el aporte mensual sugerido', async ({ authedPage }) => {
    const goalId = await combinedGoal(authedPage, '3000.00', { targetDate: monthsAhead(6) });
    await authedPage.goto(`/metas/${goalId}`);
    await expect(authedPage.getByText(/sugerid/i).first()).toBeVisible();
  });

  test('RF-M12-06 sin fecha se muestra la calculadora', async ({ authedPage }) => {
    const goalId = await combinedGoal(authedPage, '3000.00');
    await authedPage.goto(`/metas/${goalId}`);
    await expect(authedPage.getByText(/llegas en/i).first()).toBeVisible();
  });

  test('RF-M12-06 si el progreso ya alcanzó el objetivo no se muestra el sugerido', async ({
    authedPage,
  }) => {
    const goalId = await combinedGoal(authedPage, '1000.00', { targetDate: monthsAhead(6) });
    await authedPage.goto(`/metas/${goalId}`);
    await expect(authedPage.getByText(/1\.200,00/).first()).toBeVisible();
    await expect(authedPage.getByText(/aporte.*sugerid|sugerid.*aporte/i)).toHaveCount(0);
  });

  test('TASK-190 la celebración aparece una sola vez', async ({ authedPage }) => {
    const goalId = await combinedGoal(authedPage, '1000.00');
    await authedPage.goto(`/metas/${goalId}`);
    const dialog = authedPage.getByRole('dialog');
    await expect(dialog).toBeVisible();
    await expect(dialog.getByText(/1\.200,00/)).toBeVisible();
    await dialog.getByRole('button').first().click();
    await expect(dialog).toHaveCount(0);

    await authedPage.reload();
    await expect(authedPage.getByText(/1\.200,00/).first()).toBeVisible();
    await expect(authedPage.getByRole('dialog')).toHaveCount(0);
  });

  test('TASK-190 una meta inexistente muestra ResourceNotFound', async ({ authedPage }) => {
    await authedPage.goto(`/metas/${randomUUID()}`);
    await expect(authedPage.getByText(/no existe|no encontrad/i).first()).toBeVisible();
  });
});
