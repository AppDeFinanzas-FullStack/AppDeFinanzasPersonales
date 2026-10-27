import { randomUUID } from 'node:crypto';

import type { Page } from '@playwright/test';

import { expect, test } from './fixtures/auth.js';

function today(): string {
  return new Date().toISOString().slice(0, 10);
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

async function createCard(page: Page, name: string): Promise<string> {
  const id = randomUUID();
  const res = await page.request.post('/api/accounts', {
    data: {
      id,
      type: 'credit_card',
      name,
      currencyCode: 'BOB',
      initialBalance: { kind: 'debt', amount: '0.00' },
      initialBalanceDate: today(),
      color: 'teal',
      icon: 'wallet',
      card: { cutDay: 10, payDay: 20, limit: '5000.00' },
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

test.describe('TASK-191 diálogos de metas', () => {
  test('RF-M12-01 crear una meta desde el formulario', async ({ authedPage }) => {
    await authedPage.goto('/metas');
    await authedPage
      .getByRole('button', { name: /nueva meta|crear meta/i })
      .first()
      .click();
    const dialog = authedPage.getByRole('dialog');
    await dialog.getByLabel(/nombre/i).fill('Laptop');
    await dialog.getByLabel(/objetivo/i).fill('5000');
    await dialog.getByRole('button', { name: /guardar|crear/i }).click();
    await expect(authedPage.getByRole('link', { name: /Laptop/ })).toBeVisible();
  });

  test('RF-M12-01 el objetivo debe ser mayor que 0', async ({ authedPage }) => {
    await authedPage.goto('/metas');
    await authedPage
      .getByRole('button', { name: /nueva meta|crear meta/i })
      .first()
      .click();
    const dialog = authedPage.getByRole('dialog');
    await dialog.getByLabel(/nombre/i).fill('Laptop');
    await dialog.getByLabel(/objetivo/i).fill('0');
    await dialog.getByRole('button', { name: /guardar|crear/i }).click();
    await expect(dialog).toBeVisible();
    await expect(authedPage.getByRole('link', { name: /Laptop/ })).toHaveCount(0);
  });

  test('EC-M12-01 apartar más que el saldo libre muestra el saldo libre', async ({
    authedPage,
  }) => {
    await createAccount(authedPage, 'Efectivo', '100.00');
    const goalId = await createGoal(authedPage, 'Viaje', '3000.00');
    await authedPage.goto(`/metas/${goalId}`);
    await authedPage
      .getByRole('button', { name: /apartar/i })
      .first()
      .click();
    const dialog = authedPage.getByRole('dialog');
    await expect(dialog.getByText(/100,00/).first()).toBeVisible();
    await dialog.getByLabel(/monto/i).fill('500');
    await dialog
      .getByRole('button', { name: /apartar|guardar|confirmar/i })
      .last()
      .click();
    await expect(dialog).toBeVisible();
    await expect(dialog.getByText(/libre/i).first()).toBeVisible();
    await expect(dialog.getByText(/100,00/).first()).toBeVisible();
  });

  test('RF-M12-03 apartar actualiza el progreso de la meta', async ({ authedPage }) => {
    await createAccount(authedPage, 'Efectivo', '400.00');
    const goalId = await createGoal(authedPage, 'Viaje', '3000.00');
    await authedPage.goto(`/metas/${goalId}`);
    await authedPage
      .getByRole('button', { name: /apartar/i })
      .first()
      .click();
    const dialog = authedPage.getByRole('dialog');
    await dialog.getByLabel(/monto/i).fill('150');
    await dialog
      .getByRole('button', { name: /apartar|guardar|confirmar/i })
      .last()
      .click();
    await expect(authedPage.getByRole('dialog')).toHaveCount(0);
    await expect(authedPage.getByText(/150,00/).first()).toBeVisible();
  });

  test('RF-M12-03 liberar un apartado devuelve el saldo a la cuenta', async ({ authedPage }) => {
    const account = await createAccount(authedPage, 'Efectivo', '400.00');
    const goalId = await createGoal(authedPage, 'Viaje', '3000.00');
    await earmark(authedPage, goalId, account, '150.00');
    await authedPage.goto(`/metas/${goalId}`);
    await expect(authedPage.getByText(/150,00/).first()).toBeVisible();
    await authedPage
      .getByRole('button', { name: /liberar/i })
      .first()
      .click();
    const dialog = authedPage.getByRole('dialog');
    await dialog.getByLabel(/monto/i).fill('150');
    await dialog
      .getByRole('button', { name: /liberar|guardar|confirmar/i })
      .last()
      .click();
    await expect(authedPage.getByRole('dialog')).toHaveCount(0);
    const res = await authedPage.request.get(`/api/goals/${goalId}`);
    const body = (await res.json()) as { progress: string };
    expect(Number(body.progress)).toBe(0);
  });

  test('EC-M12-08 el diálogo de dedicar no lista tarjetas', async ({ authedPage }) => {
    await createAccount(authedPage, 'Ahorro', '850.00', 'savings');
    await createCard(authedPage, 'Visa Oro');
    const goalId = await createGoal(authedPage, 'Viaje', '3000.00');
    await authedPage.goto(`/metas/${goalId}`);
    await authedPage
      .getByRole('button', { name: /dedicar/i })
      .first()
      .click();
    const dialog = authedPage.getByRole('dialog');
    await expect(dialog.getByText('Ahorro').first()).toBeVisible();
    await expect(dialog.getByText('Visa Oro')).toHaveCount(0);
  });

  test('RF-M12-03 dedicar una cuenta a la meta', async ({ authedPage }) => {
    const savings = await createAccount(authedPage, 'Ahorro', '850.00', 'savings');
    const goalId = await createGoal(authedPage, 'Viaje', '3000.00');
    await authedPage.goto(`/metas/${goalId}`);
    await authedPage
      .getByRole('button', { name: /dedicar/i })
      .first()
      .click();
    const dialog = authedPage.getByRole('dialog');
    await dialog.getByText('Ahorro').first().click();
    await dialog
      .getByRole('button', { name: /dedicar|guardar|confirmar/i })
      .last()
      .click();
    await expect(authedPage.getByRole('dialog')).toHaveCount(0);
    const res = await authedPage.request.get(`/api/goals/${goalId}`);
    const body = (await res.json()) as { dedicatedAccount?: { id: string } | null };
    expect(body.dedicatedAccount?.id).toBe(savings);
  });

  test('RF-M12-09 Usar y cerrar: la meta queda Archivada y sus apartados en 0', async ({
    authedPage,
  }) => {
    const bank = await createAccount(authedPage, 'Banco', '500.00', 'bank');
    const cash = await createAccount(authedPage, 'Efectivo', '400.00');
    const goalId = await createGoal(authedPage, 'Laptop', '300.00');
    await earmark(authedPage, goalId, bank, '200.00');
    await earmark(authedPage, goalId, cash, '150.00');
    // The goal is achieved: mark the celebration as seen before opening the page.
    const celebrated = await authedPage.request.post(`/api/goals/${goalId}/celebrated`);
    expect(celebrated.ok()).toBe(true);
    await authedPage.goto(`/metas/${goalId}`);
    await expect(authedPage.getByRole('dialog')).toHaveCount(0);
    await authedPage
      .getByRole('button', { name: /usar y cerrar/i })
      .first()
      .click();
    const dialog = authedPage.getByRole('dialog');
    await dialog
      .getByRole('button', { name: /usar y cerrar|confirmar/i })
      .last()
      .click();
    await expect(authedPage.getByText(/archivada/i).first()).toBeVisible();
    const res = await authedPage.request.get(`/api/goals/${goalId}`);
    const body = (await res.json()) as { status: string; progress: string };
    expect(body.status).toBe('archived');
    expect(Number(body.progress)).toBe(0);
  });
});
