import type { Page } from '@playwright/test';

import { expect, test } from './fixtures/mailbox.js';
import type { MailboxFixtures } from './fixtures/mailbox.js';

type Mailbox = MailboxFixtures['mailbox'];

const PASSWORD = 'Contrasena-segura-1';
const TIMEZONE = 'America/La_Paz';
const BOLIVIA_OFFSET_MS = 4 * 60 * 60 * 1000;

/** The suggested accounts of step 2, in order (spec §2.10.1). */
const CASH = 0;
const BANK = 1;
const USD_CASH = 2;

/** The explanation of a negative initial balance (EC-M10-01) and of a repeated name (EC-M10-02). */
const NEGATIVE_EXPLANATION = /negativo/i;
const DUPLICATE_EXPLANATION = /duplicad|mismo nombre|ya (tienes|existe)|en uso/i;

interface AccountItem {
  name: string;
  type: string;
  currencyCode: string;
  initialBalance: string;
  initialBalanceDate: string;
  balance: string;
}

interface AccountListBody {
  items: AccountItem[];
}

interface OnboardingBody {
  step: number;
  completed: boolean;
}

/** Today in Bolivia (UTC-4) as `YYYY-MM-DD`. */
function today(): string {
  const now = new Date(Date.now() - BOLIVIA_OFFSET_MS);
  const month = String(now.getUTCMonth() + 1).padStart(2, '0');
  const day = String(now.getUTCDate()).padStart(2, '0');
  return `${String(now.getUTCFullYear())}-${month}-${day}`;
}

async function getJson<T>(page: Page, path: string): Promise<T> {
  const res = await page.request.get(path);
  expect(res.status(), path).toBe(200);
  return (await res.json()) as T;
}

async function activeAccounts(page: Page): Promise<AccountItem[]> {
  return (await getJson<AccountListBody>(page, '/api/accounts?status=active')).items;
}

/** The i-th suggested account (the cards come in the order of the spec). */
function checkbox(page: Page, index: number) {
  return page.getByRole('checkbox').nth(index);
}

function nameField(page: Page, index: number) {
  return page.getByLabel(/nombre/i).nth(index);
}

function balanceField(page: Page, index: number) {
  return page.getByLabel(/saldo de hoy/i).nth(index);
}

/**
 * A user just confirmed (spec §2.10.1): signs up, waits on "Revisa tu correo" and opens the
 * confirmation link in another tab; the waiting tab continues to the Onboarding (RF-M1-18).
 */
async function confirmedNewUser(page: Page, mailbox: Mailbox): Promise<void> {
  const email = mailbox.newEmail();
  await page.goto('/registro');
  await page.getByLabel(/nombre/i).fill('Ana Prueba');
  await page.getByLabel(/correo/i).fill(email);
  await page.getByLabel(/contraseña/i).fill(PASSWORD);
  await page.getByRole('checkbox').check();
  await page.getByRole('button', { name: /crear cuenta/i }).click();
  await expect(page).toHaveURL(/\/revisa-tu-correo/);
  const linkPage = await page.context().newPage();
  await linkPage.goto(await mailbox.confirmationLink(email));
  await expect(linkPage.getByText('Correo confirmado').first()).toBeVisible();
  await linkPage.close();
  await page.bringToFront();
  await expect(page).toHaveURL(/\/bienvenida/, { timeout: 20_000 });
}

/** Confirms the user and moves on to step 2 with the base currency by default. */
async function userInStep2(page: Page, mailbox: Mailbox): Promise<void> {
  await confirmedNewUser(page, mailbox);
  await expect(page.getByText(/Paso 1 de 3/).first()).toBeVisible();
  await page.getByRole('button', { name: /continuar/i }).click();
  await expect(page.getByText(/Paso 2 de 3/).first()).toBeVisible();
}

async function onboardingStep(page: Page): Promise<number> {
  return (await getJson<OnboardingBody>(page, '/api/onboarding')).step;
}

test.describe('TASK-161 Onboarding: paso 2 (cuentas)', () => {
  test.use({ timezoneId: TIMEZONE });

  test('TASK-161 el paso 2 muestra las fichas Efectivo y Banco marcadas, Dólares sin marcar y saldo en 0', async ({
    page,
    mailbox,
  }) => {
    await userInStep2(page, mailbox);

    await expect(checkbox(page, CASH)).toBeChecked();
    await expect(checkbox(page, BANK)).toBeChecked();
    await expect(checkbox(page, USD_CASH)).not.toBeChecked();

    await expect(nameField(page, CASH)).toHaveValue('Efectivo (Bs)');
    await expect(nameField(page, BANK)).toHaveValue('Banco (Bs)');
    await expect(balanceField(page, CASH)).toHaveValue(/^0([.,]0+)?$/);
    await expect(balanceField(page, BANK)).toHaveValue(/^0([.,]0+)?$/);

    await expect(page.getByText('Dólares en efectivo ($)').first()).toBeVisible();
    await expect(page.getByRole('button', { name: /\+?\s*Otra cuenta/ })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Saltar paso' })).toBeVisible();
  });

  test('TASK-161 "+ Otra cuenta" abre un formulario corto con nombre', async ({ page, mailbox }) => {
    await userInStep2(page, mailbox);
    const before = await page.getByLabel(/nombre/i).count();

    await page.getByRole('button', { name: /\+?\s*Otra cuenta/ }).click();

    await expect.poll(async () => page.getByLabel(/nombre/i).count()).toBeGreaterThan(before);
  });

  test('RF-M10-04 con los saldos en 0 se crean las cuentas marcadas con saldo 0 y fecha de hoy', async ({
    page,
    mailbox,
  }) => {
    await userInStep2(page, mailbox);

    await page.getByRole('button', { name: /continuar/i }).click();

    await expect(page.getByText(/Paso 3 de 3/).first()).toBeVisible();
    const accounts = await activeAccounts(page);
    expect(accounts.map((a) => a.name).sort()).toEqual(['Banco (Bs)', 'Efectivo (Bs)']);
    for (const account of accounts) {
      expect(account.initialBalance).toBe('0.00');
      expect(account.initialBalanceDate).toBe(today());
      expect(account.currencyCode).toBe('BOB');
    }
    expect(await onboardingStep(page)).toBe(3);
  });

  test('RF-M10-04 las cuentas creadas tienen el saldo indicado, el nombre editado y fecha de hoy', async ({
    page,
    mailbox,
  }) => {
    await userInStep2(page, mailbox);

    await nameField(page, CASH).fill('Caja chica');
    await balanceField(page, CASH).fill('150');
    await balanceField(page, BANK).fill('200,50');
    await checkbox(page, USD_CASH).check();
    await balanceField(page, USD_CASH).fill('30');
    await page.getByRole('button', { name: /continuar/i }).click();

    await expect(page.getByText(/Paso 3 de 3/).first()).toBeVisible();
    const accounts = await activeAccounts(page);
    const byName = new Map(accounts.map((a) => [a.name, a]));
    expect([...byName.keys()].sort()).toEqual(['Banco (Bs)', 'Caja chica', 'Dólares en efectivo ($)']);

    const cash = byName.get('Caja chica');
    const bank = byName.get('Banco (Bs)');
    const usd = byName.get('Dólares en efectivo ($)');
    expect(cash).toMatchObject({ type: 'cash', currencyCode: 'BOB', initialBalance: '150.00' });
    expect(bank).toMatchObject({ type: 'bank', currencyCode: 'BOB', initialBalance: '200.50' });
    expect(usd).toMatchObject({ type: 'cash', currencyCode: 'USD', initialBalance: '30.00' });
    for (const account of accounts) {
      expect(account.initialBalanceDate).toBe(today());
      expect(account.balance).toBe(account.initialBalance);
    }
  });

  test('RF-M10-04 una ficha desmarcada no crea cuenta aunque tenga saldo', async ({
    page,
    mailbox,
  }) => {
    await userInStep2(page, mailbox);

    await checkbox(page, BANK).uncheck();
    await balanceField(page, CASH).fill('10');
    await page.getByRole('button', { name: /continuar/i }).click();

    await expect(page.getByText(/Paso 3 de 3/).first()).toBeVisible();
    const accounts = await activeAccounts(page);
    expect(accounts.map((a) => a.name)).toEqual(['Efectivo (Bs)']);
  });

  test('RF-M10-04 un banco admite saldo negativo (RF-M4-02)', async ({ page, mailbox }) => {
    await userInStep2(page, mailbox);

    await balanceField(page, BANK).fill('-20');
    await page.getByRole('button', { name: /continuar/i }).click();

    await expect(page.getByText(/Paso 3 de 3/).first()).toBeVisible();
    const accounts = await activeAccounts(page);
    const bank = accounts.find((a) => a.name === 'Banco (Bs)');
    expect(bank?.initialBalance).toBe('-20.00');
  });

  test('EC-M10-01 un saldo negativo en efectivo muestra la explicación y no crea cuentas', async ({
    page,
    mailbox,
  }) => {
    await userInStep2(page, mailbox);

    await balanceField(page, CASH).fill('-50');
    await page.getByRole('button', { name: /continuar/i }).click();

    await expect(page.getByText(NEGATIVE_EXPLANATION).first()).toBeVisible();
    await expect(page.getByText(/Paso 2 de 3/).first()).toBeVisible();
    await expect(page.getByText(/Paso 3 de 3/)).toHaveCount(0);
    expect(await activeAccounts(page)).toHaveLength(0);
    expect(await onboardingStep(page)).toBe(2);

    // Corregido el saldo, el paso se puede completar.
    await balanceField(page, CASH).fill('0');
    await page.getByRole('button', { name: /continuar/i }).click();
    await expect(page.getByText(/Paso 3 de 3/).first()).toBeVisible();
    expect(await activeAccounts(page)).toHaveLength(2);
  });

  test('EC-M10-02 dos nombres iguales muestran el error de duplicado y no crean cuentas', async ({
    page,
    mailbox,
  }) => {
    await userInStep2(page, mailbox);

    // Sin distinguir mayúsculas (RF-M4-01).
    await nameField(page, BANK).fill('efectivo (BS)');
    await page.getByRole('button', { name: /continuar/i }).click();

    await expect(page.getByText(DUPLICATE_EXPLANATION).first()).toBeVisible();
    await expect(page.getByText(/Paso 2 de 3/).first()).toBeVisible();
    await expect(page.getByText(/Paso 3 de 3/)).toHaveCount(0);
    expect(await activeAccounts(page)).toHaveLength(0);
    expect(await onboardingStep(page)).toBe(2);

    // Con un nombre distinto, el paso se puede completar.
    await nameField(page, BANK).fill('Banco principal');
    await page.getByRole('button', { name: /continuar/i }).click();
    await expect(page.getByText(/Paso 3 de 3/).first()).toBeVisible();
    const accounts = await activeAccounts(page);
    expect(accounts.map((a) => a.name).sort()).toEqual(['Banco principal', 'Efectivo (Bs)']);
  });

  test('TASK-161 el borrador del paso 2 se conserva al recargar la página', async ({
    page,
    mailbox,
  }) => {
    await userInStep2(page, mailbox);

    await nameField(page, CASH).fill('Caja chica');
    await balanceField(page, CASH).fill('75');
    // The draft is saved a moment after the last change.
    await expect
      .poll(async () =>
        page.evaluate(() => {
          const keys = [...Object.keys(localStorage), ...Object.keys(sessionStorage)];
          return keys.some((key) => key.includes('onboarding-step2'));
        }),
      )
      .toBe(true);

    await page.reload();

    await expect(page.getByText(/Paso 2 de 3/).first()).toBeVisible();
    await expect(nameField(page, CASH)).toHaveValue('Caja chica');
    await expect(balanceField(page, CASH)).toHaveValue(/^75([.,]0+)?$/);
  });
});
