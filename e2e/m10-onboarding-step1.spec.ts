import type { Page } from '@playwright/test';

import { expect, test } from './fixtures/mailbox.js';
import type { MailboxFixtures } from './fixtures/mailbox.js';

type Mailbox = MailboxFixtures['mailbox'];

const PASSWORD = 'Contrasena-segura-1';
const TIMEZONE = 'America/La_Paz';
const BOLIVIA_OFFSET_MS = 4 * 60 * 60 * 1000;

/** The two choices of the base currency in step 1 (spec §2.10.1). */
const BOB_OPTION = /BOB|boliviano/i;
const USD_OPTION = /USD|dólar/i;

interface CategoryNode {
  id: string;
  children: CategoryNode[];
}

interface OnboardingRate {
  kind: string;
  value: string | null;
}

interface OnboardingBody {
  step: number;
  completed: boolean;
  presets: { accounts: unknown[]; categories: CategoryNode[] };
  rate: OnboardingRate | null;
}

interface RatesCurrentBody {
  base: string;
}

interface AccountListBody {
  items: { id: string }[];
}

interface MeBody {
  onboarding: { step: number; completed: boolean };
}

/** Current month in Bolivia (UTC-4) as `YYYY-MM`. */
function currentMonth(): string {
  const now = new Date(Date.now() - BOLIVIA_OFFSET_MS);
  return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}`;
}

function flattenIds(nodes: CategoryNode[]): string[] {
  return nodes.flatMap((n) => [n.id, ...flattenIds(n.children)]);
}

async function getJson<T>(page: Page, path: string): Promise<T> {
  const res = await page.request.get(path);
  expect(res.status(), path).toBe(200);
  return (await res.json()) as T;
}

/** Active categories of both kinds, as a sorted list of ids. */
async function activeCategoryIds(page: Page): Promise<string[]> {
  const expense = await getJson<CategoryNode[]>(page, '/api/categories?kind=expense&status=active');
  const income = await getJson<CategoryNode[]>(page, '/api/categories?kind=income&status=active');
  return [...flattenIds(expense), ...flattenIds(income)].sort();
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

/** Serves `GET /api/onboarding` with the given USD rate in use (`null`: there is no rate yet). */
async function serveOnboardingRate(page: Page, rate: OnboardingRate | null): Promise<void> {
  await page.route(/\/api\/onboarding(\?.*)?$/, async (route) => {
    if (route.request().method() !== 'GET') {
      await route.continue();
      return;
    }
    const response = await route.fetch();
    if (!response.ok()) {
      await route.fulfill({ response });
      return;
    }
    const body = (await response.json()) as OnboardingBody;
    await route.fulfill({ response, json: { ...body, rate } });
  });
}

test.describe('TASK-160 Onboarding: indicador de pasos y paso 1', () => {
  test.use({ timezoneId: TIMEZONE });

  test('TASK-160 el paso 1 muestra "Paso 1 de 3", "Saltar paso", "Saltar todo" y BOB por defecto', async ({
    page,
    mailbox,
  }) => {
    await confirmedNewUser(page, mailbox);
    await expect(page.getByText(/Paso 1 de 3/).first()).toBeVisible();
    await expect(page.getByRole('button', { name: 'Saltar paso' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Saltar todo' })).toBeVisible();
    await expect(page.getByRole('radio', { name: BOB_OPTION })).toBeChecked();
    await expect(page.getByRole('radio', { name: USD_OPTION })).not.toBeChecked();
  });

  test('RF-M10-02 Saltar todo: la base es BOB, no hay cuentas, están todas las categorías y el Inicio invita a crear la primera cuenta', async ({
    page,
    mailbox,
  }) => {
    await confirmedNewUser(page, mailbox);
    await expect(page.getByText(/Paso 1 de 3/).first()).toBeVisible();
    const before = await getJson<OnboardingBody>(page, '/api/onboarding');
    const presetIds = flattenIds(before.presets.categories).sort();
    expect(presetIds.length).toBeGreaterThan(0);

    await page.getByRole('button', { name: 'Saltar todo' }).click();

    // Al terminar, el Inicio del mes actual.
    const month = currentMonth();
    await expect(page).toHaveURL(
      (url) => url.pathname === '/' && (url.searchParams.get('mes') ?? month) === month,
    );
    await expect(page.getByRole('heading', { name: 'Crea tu primera cuenta' })).toBeVisible();

    await expect
      .poll(async () => (await getJson<MeBody>(page, '/api/me')).onboarding.completed)
      .toBe(true);
    const rates = await getJson<RatesCurrentBody>(page, '/api/rates/current');
    expect(rates.base).toBe('BOB');
    const accounts = await getJson<AccountListBody>(page, '/api/accounts?status=active');
    expect(accounts.items).toHaveLength(0);
    expect(await activeCategoryIds(page)).toEqual(presetIds);
  });

  test('RF-M10-02 Saltar el paso 1 deja BOB aunque se haya marcado USD', async ({
    page,
    mailbox,
  }) => {
    await confirmedNewUser(page, mailbox);
    await expect(page.getByText(/Paso 1 de 3/).first()).toBeVisible();
    const usd = page.getByRole('radio', { name: USD_OPTION });
    await usd.click();
    await expect(usd).toBeChecked();

    await page.getByRole('button', { name: 'Saltar paso' }).click();

    await expect(page.getByText(/Paso 2 de 3/).first()).toBeVisible();
    await expect
      .poll(async () => (await getJson<OnboardingBody>(page, '/api/onboarding')).step)
      .toBe(2);
    const rates = await getJson<RatesCurrentBody>(page, '/api/rates/current');
    expect(rates.base).toBe('BOB');
  });

  test('RF-M10-01 Continuar en el paso 1 guarda la base elegida y al volver retoma en el paso 2', async ({
    page,
    mailbox,
  }) => {
    await confirmedNewUser(page, mailbox);
    await expect(page.getByText(/Paso 1 de 3/).first()).toBeVisible();
    const usd = page.getByRole('radio', { name: USD_OPTION });
    await usd.click();
    await expect(usd).toBeChecked();
    await page.getByRole('button', { name: /continuar/i }).click();

    await expect(page.getByText(/Paso 2 de 3/).first()).toBeVisible();
    await expect
      .poll(async () => (await getJson<OnboardingBody>(page, '/api/onboarding')).step)
      .toBe(2);
    const rates = await getJson<RatesCurrentBody>(page, '/api/rates/current');
    expect(rates.base).toBe('USD');

    // Si se interrumpe, retoma en el paso pendiente sin repreguntar el paso 1.
    await page.reload();
    await expect(page.getByText(/Paso 2 de 3/).first()).toBeVisible();
    await expect(page.getByText(/Paso 1 de 3/)).toHaveCount(0);
    await page.goto('/');
    await expect(page).toHaveURL(/\/bienvenida/);
    await expect(page.getByText(/Paso 2 de 3/).first()).toBeVisible();
    await expect(page.getByText(/Paso 1 de 3/)).toHaveCount(0);
  });

  test('TASK-160 sin tasa, el paso 1 dice "Aún no pudimos obtener el dólar"', async ({
    page,
    mailbox,
  }) => {
    await serveOnboardingRate(page, null);
    await confirmedNewUser(page, mailbox);
    await expect(page.getByText(/Paso 1 de 3/).first()).toBeVisible();
    await expect(page.getByText(/Aún no pudimos obtener el dólar/).first()).toBeVisible();
    await expect(page.getByText(/Usaremos el dólar paralelo/)).toHaveCount(0);
  });

  test('TASK-160 con tasa, el paso 1 dice "Usaremos el dólar paralelo: Bs 10,25"', async ({
    page,
    mailbox,
  }) => {
    await serveOnboardingRate(page, { kind: 'parallel_median', value: '10.25' });
    await confirmedNewUser(page, mailbox);
    await expect(page.getByText(/Paso 1 de 3/).first()).toBeVisible();
    await expect(page.getByText(/Usaremos el dólar paralelo:?\s*Bs\s?10,25/).first()).toBeVisible();
    await expect(page.getByText(/Aún no pudimos obtener el dólar/)).toHaveCount(0);
  });
});
