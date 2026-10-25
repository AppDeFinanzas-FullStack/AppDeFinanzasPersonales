import { randomUUID } from 'node:crypto';

import type { Page } from '@playwright/test';

import { expect, test } from './fixtures/auth.js';

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

async function createGeneralBudget(page: Page, amount: string): Promise<string> {
  const id = randomUUID();
  const res = await page.request.post('/api/budgets', {
    data: { id, scope: 'general', amount, currencyCode: 'BOB' },
  });
  expect(res.status()).toBe(201);
  return id;
}

function currentMonthPattern(): RegExp {
  const now = new Date();
  const long = new Intl.DateTimeFormat('es-BO', { month: 'long' }).format(now);
  const short = long.slice(0, 3);
  const mm = String(now.getMonth() + 1).padStart(2, '0');
  return new RegExp(`${long}|\\b${short}\\b|\\d{1,2}/${mm}`, 'i');
}

test.describe('TASK-219 Inicio: bloque Presupuesto del mes', () => {
  test('RF-M8-08 el Inicio muestra una barra por presupuesto activo con su período', async ({
    authedPage,
  }) => {
    await createAccount(authedPage, 'Efectivo', '500');
    await createGeneralBudget(authedPage, '1000.00');
    await authedPage.goto('/');
    await expect(authedPage.getByText('Presupuesto del mes').first()).toBeVisible();
    await expect(authedPage.getByRole('progressbar').first()).toBeVisible();
    await expect(authedPage.getByText(currentMonthPattern()).first()).toBeVisible();
  });

  test('RF-M8-10 el bloque de presupuestos lleva a Presupuestos', async ({ authedPage }) => {
    await createAccount(authedPage, 'Efectivo', '500');
    await createGeneralBudget(authedPage, '1000.00');
    await authedPage.goto('/');
    await expect(authedPage.getByText('Presupuesto del mes').first()).toBeVisible();
    await authedPage
      .getByRole('link', { name: /presupuesto/i })
      .first()
      .click();
    await expect(authedPage).toHaveURL(/\/presupuestos/);
  });
});
