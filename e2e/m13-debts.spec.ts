import { randomUUID } from 'node:crypto';

import type { Locator, Page } from '@playwright/test';

import { expect, test } from './fixtures/auth.js';

interface Payment {
  id: string;
  amount: string;
}

interface Debt {
  id: string;
  person: string;
  status: string;
  capitalOutstanding: string;
  interestAccrued: string;
  pending: string;
  payments: Payment[];
  forgivenAmount?: string;
}

interface DebtList {
  debts: Debt[];
}

interface TransactionList {
  items: { id: string }[];
}

/** A date `n` days before today (UTC); a few days back is "today or before" in any time zone. */
function daysAgo(n: number): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - n);
  return d.toISOString().slice(0, 10);
}

/** `1030.5` / `"1030.50"` as the es-BO text the app shows: `1.030,50`. */
function esBO(amount: string): string {
  const [int = '0', dec = '00'] = amount.split('.');
  const grouped = int.replace(/\B(?=(\d{3})+(?!\d))/g, '.');
  return `${grouped},${dec.padEnd(2, '0')}`;
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
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
      initialBalanceDate: daysAgo(20),
      color: 'teal',
      icon: 'wallet',
    },
  });
  expect(res.status()).toBe(201);
  return id;
}

async function createDebt(
  page: Page,
  direction: 'i_owe' | 'owed_to_me',
  person: string,
  principal: string,
  extra: Record<string, unknown> = {},
): Promise<string> {
  const id = randomUUID();
  const res = await page.request.post('/api/debts', {
    data: {
      id,
      direction,
      person,
      principal,
      currencyCode: 'BOB',
      startDate: daysAgo(10),
      ...extra,
    },
  });
  expect(res.status()).toBe(201);
  return id;
}

/** A capital-only payment, optionally from an account (it then creates one movement). */
async function pay(
  page: Page,
  debtId: string,
  amount: string,
  date: string,
  accountId?: string,
): Promise<void> {
  const res = await page.request.post(`/api/debts/${debtId}/payments`, {
    data: {
      id: randomUUID(),
      amount,
      interestPart: '0.00',
      capitalPart: amount,
      date,
      ...(accountId === undefined
        ? {}
        : {
            account: {
              accountId,
              capitalTransactionId: randomUUID(),
              interestTransactionId: randomUUID(),
            },
          }),
    },
  });
  expect(res.status()).toBe(201);
}

async function listDebts(page: Page): Promise<Debt[]> {
  const res = await page.request.get('/api/debts?view=debt');
  expect(res.ok()).toBe(true);
  return ((await res.json()) as DebtList).debts;
}

async function findDebt(page: Page, id: string): Promise<Debt | undefined> {
  return (await listDebts(page)).find((d) => d.id === id);
}

async function countTransactions(page: Page): Promise<number> {
  const res = await page.request.get('/api/transactions');
  expect(res.ok()).toBe(true);
  return ((await res.json()) as TransactionList).items.length;
}

/** Clicks the confirmation of a dialog only if the action asked for one. */
async function confirmIfAsked(page: Page, done: Locator, name: RegExp): Promise<void> {
  const dialog = page.getByRole('dialog');
  await dialog.or(done).first().waitFor();
  if (await dialog.isVisible()) {
    await dialog.getByRole('button', { name }).last().click();
  }
}

function viewToggle(page: Page, name: RegExp): Locator {
  return page
    .getByRole('tab', { name })
    .or(page.getByRole('radio', { name }))
    .or(page.getByRole('button', { name }))
    .first();
}

test.describe('TASK-217 lista y detalle de deudas', () => {
  test('RF-M13-13 el resumen muestra "Debes X · Te deben Y"', async ({ authedPage }) => {
    await createDebt(authedPage, 'i_owe', 'Juan', '500.00');
    await createDebt(authedPage, 'owed_to_me', 'Ana', '300.00');
    await authedPage.goto('/deudas');
    await expect(authedPage.locator('body')).toContainText(
      /Debes[\s\S]*500,00[\s\S]*Te deben[\s\S]*300,00/,
    );
  });

  test('RF-M13-06 la lista muestra cada deuda con su saldo pendiente', async ({ authedPage }) => {
    const debtId = await createDebt(authedPage, 'i_owe', 'Juan', '800.00');
    await pay(authedPage, debtId, '250.00', daysAgo(2));
    await authedPage.goto('/deudas');
    const row = authedPage.getByRole('link', { name: /Juan/ }).first();
    await expect(row).toBeVisible();
    await expect(row).toContainText('550,00');
  });

  test('RF-M13-13 la vista por persona muestra el neto agrupando los nombres', async ({
    authedPage,
  }) => {
    await createDebt(authedPage, 'i_owe', 'José', '200.00');
    await createDebt(authedPage, 'owed_to_me', 'jose', '500.00');
    await authedPage.goto('/deudas');
    await viewToggle(authedPage, /por persona/i).click();
    await expect(authedPage.getByText(/300,00/).first()).toBeVisible();
    await expect(authedPage.getByText(/^jos[eé]$/i)).toHaveCount(1);
  });

  test('RF-M13-06 el detalle muestra capital, interés acumulado y pendiente por separado', async ({
    authedPage,
  }) => {
    const debtId = await createDebt(authedPage, 'i_owe', 'Banco Sol', '1000.00', {
      startDate: daysAgo(30),
      interest: { rate: '3', period: 'monthly' },
    });
    const debt = await findDebt(authedPage, debtId);
    expect(debt).toBeDefined();
    expect(Number(debt?.interestAccrued)).toBeGreaterThan(0);
    await authedPage.goto(`/deudas/${debtId}`);
    await expect(authedPage.getByText(/capital/i).first()).toBeVisible();
    await expect(authedPage.getByText(/inter[eé]s/i).first()).toBeVisible();
    await expect(authedPage.getByText(/pendiente/i).first()).toBeVisible();
    for (const amount of [
      debt?.capitalOutstanding ?? '',
      debt?.interestAccrued ?? '',
      debt?.pending ?? '',
    ]) {
      await expect(
        authedPage.getByText(new RegExp(escapeRegExp(esBO(amount)))).first(),
      ).toBeVisible();
    }
  });

  test('EC-M13-05 solo el último pago ofrece "Eliminar último pago"', async ({ authedPage }) => {
    const debtId = await createDebt(authedPage, 'i_owe', 'Juan', '1000.00');
    await pay(authedPage, debtId, '100.00', daysAgo(3));
    await pay(authedPage, debtId, '200.00', daysAgo(2));
    await authedPage.goto(`/deudas/${debtId}`);
    await expect(authedPage.getByText(/100,00/).first()).toBeVisible();
    await expect(authedPage.getByText(/200,00/).first()).toBeVisible();
    await expect(authedPage.getByRole('button', { name: /eliminar último pago/i })).toHaveCount(1);
  });

  test('EC-M13-05 una deuda Condonada no ofrece eliminar pagos', async ({ authedPage }) => {
    const debtId = await createDebt(authedPage, 'i_owe', 'Juan', '1000.00');
    await pay(authedPage, debtId, '100.00', daysAgo(2));
    const forgiven = await authedPage.request.post(`/api/debts/${debtId}/forgive`);
    expect(forgiven.ok()).toBe(true);
    await authedPage.goto(`/deudas/${debtId}`);
    await expect(authedPage.getByText(/condonada/i).first()).toBeVisible();
    await expect(authedPage.getByRole('button', { name: /eliminar último pago/i })).toHaveCount(0);
  });

  test('RF-M13-12 Condonar: la deuda queda Condonada y no se crea ningún movimiento', async ({
    authedPage,
  }) => {
    const debtId = await createDebt(authedPage, 'owed_to_me', 'Ana', '300.00');
    const before = await countTransactions(authedPage);
    await authedPage.goto(`/deudas/${debtId}`);
    await authedPage
      .getByRole('button', { name: /condonar/i })
      .first()
      .click();
    await confirmIfAsked(
      authedPage,
      authedPage.getByText(/condonada/i).first(),
      /condonar|confirmar/i,
    );
    await expect(authedPage.getByText(/condonada/i).first()).toBeVisible();
    await expect(authedPage.getByText(/300,00/).first()).toBeVisible();
    const debt = await findDebt(authedPage, debtId);
    expect(debt?.status).toBe('forgiven');
    expect(Number(debt?.forgivenAmount)).toBe(300);
    expect(await countTransactions(authedPage)).toBe(before);
  });

  test('RF-M13-11 eliminar una deuda con movimientos ofrece las dos opciones con N', async ({
    authedPage,
  }) => {
    const accountId = await createAccount(authedPage, 'Efectivo', '1000.00');
    const debtId = await createDebt(authedPage, 'i_owe', 'Juan', '500.00', {
      initialMovement: { transactionId: randomUUID(), accountId },
    });
    await pay(authedPage, debtId, '200.00', daysAgo(2), accountId);
    await authedPage.goto(`/deudas/${debtId}`);
    await authedPage
      .getByRole('button', { name: /^eliminar( deuda)?$/i })
      .first()
      .click();
    const dialog = authedPage.getByRole('dialog');
    await expect(
      dialog.getByText(/eliminar también los 2 movimientos asociados/i).first(),
    ).toBeVisible();
    await expect(dialog.getByText(/conservarlos como movimientos normales/i).first()).toBeVisible();
  });

  test('RF-M13-11 conservar los movimientos elimina la deuda y deja los movimientos', async ({
    authedPage,
  }) => {
    const accountId = await createAccount(authedPage, 'Efectivo', '1000.00');
    const debtId = await createDebt(authedPage, 'i_owe', 'Juan', '500.00', {
      initialMovement: { transactionId: randomUUID(), accountId },
    });
    await pay(authedPage, debtId, '200.00', daysAgo(2), accountId);
    const before = await countTransactions(authedPage);
    await authedPage.goto(`/deudas/${debtId}`);
    await authedPage
      .getByRole('button', { name: /^eliminar( deuda)?$/i })
      .first()
      .click();
    const dialog = authedPage.getByRole('dialog');
    await dialog
      .getByText(/conservarlos como movimientos normales/i)
      .first()
      .click();
    await expect(async () => {
      if (await dialog.isVisible()) {
        await dialog
          .getByRole('button', { name: /^(eliminar|confirmar)$/i })
          .last()
          .click({ timeout: 1000 });
      }
      expect(await findDebt(authedPage, debtId)).toBeUndefined();
    }).toPass();
    expect(await countTransactions(authedPage)).toBe(before);
  });

  test('RF-M13-11 eliminar también los movimientos borra la deuda y sus N movimientos', async ({
    authedPage,
  }) => {
    const accountId = await createAccount(authedPage, 'Efectivo', '1000.00');
    const debtId = await createDebt(authedPage, 'i_owe', 'Juan', '500.00', {
      initialMovement: { transactionId: randomUUID(), accountId },
    });
    await pay(authedPage, debtId, '200.00', daysAgo(2), accountId);
    const before = await countTransactions(authedPage);
    await authedPage.goto(`/deudas/${debtId}`);
    await authedPage
      .getByRole('button', { name: /^eliminar( deuda)?$/i })
      .first()
      .click();
    const dialog = authedPage.getByRole('dialog');
    await dialog
      .getByText(/eliminar también los 2 movimientos asociados/i)
      .first()
      .click();
    await expect(async () => {
      if (await dialog.isVisible()) {
        await dialog
          .getByRole('button', { name: /^(eliminar|confirmar)$/i })
          .last()
          .click({ timeout: 1000 });
      }
      expect(await findDebt(authedPage, debtId)).toBeUndefined();
    }).toPass();
    expect(await countTransactions(authedPage)).toBe(before - 2);
  });
});
