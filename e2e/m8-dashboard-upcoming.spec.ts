import { randomUUID } from 'node:crypto';

import type { Page } from '@playwright/test';

import { expect, test } from './fixtures/auth.js';

const BOLIVIA_OFFSET_MS = 4 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

/** The day `offset` days from today in Bolivia (UTC-4), as `YYYY-MM-DD`. */
function dayFromToday(offset: number): string {
  return new Date(Date.now() - BOLIVIA_OFFSET_MS + offset * DAY_MS).toISOString().slice(0, 10);
}

async function createDebt(
  page: Page,
  person: string,
  dueDate: string,
  direction: 'i_owe' | 'owed_to_me' = 'i_owe',
): Promise<string> {
  const id = randomUUID();
  const res = await page.request.post('/api/debts', {
    data: {
      id,
      direction,
      person,
      principal: '300.00',
      currencyCode: 'BOB',
      startDate: dayFromToday(-10),
      dueDate,
    },
  });
  expect(res.status()).toBe(201);
  return id;
}

/** First day of the previous calendar month in Bolivia, as `YYYY-MM-DD`. */
function previousMonthStart(): string {
  const now = new Date(Date.now() - BOLIVIA_OFFSET_MS);
  const y = now.getUTCMonth() === 0 ? now.getUTCFullYear() - 1 : now.getUTCFullYear();
  const m = now.getUTCMonth() === 0 ? 12 : now.getUTCMonth();
  return `${y}-${String(m).padStart(2, '0')}-01`;
}

async function createAccount(page: Page, initialBalanceDate: string): Promise<void> {
  const res = await page.request.post('/api/accounts', {
    data: {
      id: randomUUID(),
      type: 'cash',
      name: 'Efectivo',
      currencyCode: 'BOB',
      initialBalance: '100',
      initialBalanceDate,
      color: 'teal',
      icon: 'wallet',
    },
  });
  expect(res.status()).toBe(201);
}

const TITLE = 'Próximos pagos y deudas';

test.describe('TASK-220 Inicio: bloque Próximos pagos y deudas', () => {
  test('RF-M8-09 el Inicio lista la deuda que vence en 5 días y no la que vence en 8', async ({
    authedPage,
  }) => {
    await createAccount(authedPage, previousMonthStart());
    await createDebt(authedPage, 'Carla Pronto', dayFromToday(5));
    await createDebt(authedPage, 'Mario Tarde', dayFromToday(8), 'owed_to_me');
    await authedPage.goto('/');
    await expect(authedPage.getByText(TITLE).first()).toBeVisible();
    await expect(authedPage.getByText('Carla Pronto').first()).toBeVisible();
    await expect(authedPage.getByText('Mario Tarde')).toHaveCount(0);
  });

  test('RF-M8-09 en un mes pasado el bloque no aparece', async ({ authedPage }) => {
    await createAccount(authedPage, previousMonthStart());
    await createDebt(authedPage, 'Lucia Pasado', dayFromToday(3));
    await authedPage.goto('/');
    await expect(authedPage.getByText(TITLE).first()).toBeVisible();
    await authedPage.getByRole('button', { name: 'Mes anterior' }).click();
    await expect(authedPage).toHaveURL(new RegExp(`mes=${previousMonthStart().slice(0, 7)}`));
    await expect(authedPage.getByText('Saldos por cuenta').first()).toBeVisible();
    await expect(authedPage.getByText(TITLE)).toHaveCount(0);
    await expect(authedPage.getByText('Lucia Pasado')).toHaveCount(0);
  });
});
