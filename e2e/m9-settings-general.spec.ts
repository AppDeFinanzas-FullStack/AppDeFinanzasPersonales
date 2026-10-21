import { randomUUID } from 'node:crypto';

import type { Browser, BrowserContext, Page } from '@playwright/test';

import { expect, test } from './fixtures/auth.js';
import type { TestUser } from './fixtures/auth.js';

interface CategoryNode {
  id: string;
  kind: string;
  status: string;
  children: CategoryNode[];
}

interface Settings {
  numberFormat: string;
  dateFormat: string;
  weekStart: string;
  theme: string;
}

const BOLIVIA_OFFSET_MS = 4 * 60 * 60 * 1000;

const pad = (n: number): string => String(n).padStart(2, '0');

/** First day of the previous calendar month in Bolivia (UTC-4), always older than the week. */
function previousMonthStart(): string {
  const now = new Date(Date.now() - BOLIVIA_OFFSET_MS);
  const y = now.getUTCMonth() === 0 ? now.getUTCFullYear() - 1 : now.getUTCFullYear();
  const m = now.getUTCMonth() === 0 ? 12 : now.getUTCMonth();
  return `${y}-${pad(m)}-01`;
}

function flatten(nodes: CategoryNode[]): CategoryNode[] {
  return nodes.flatMap((n) => [n, ...flatten(n.children)]);
}

async function getSettings(page: Page): Promise<Settings> {
  const res = await page.request.get('/api/settings');
  expect(res.ok()).toBe(true);
  return (await res.json()) as Settings;
}

async function createAccount(page: Page, name: string): Promise<string> {
  const id = randomUUID();
  const res = await page.request.post('/api/accounts', {
    data: {
      id,
      type: 'cash',
      name,
      currencyCode: 'BOB',
      initialBalance: '500',
      initialBalanceDate: previousMonthStart(),
      color: 'teal',
      icon: 'wallet',
    },
  });
  expect(res.status()).toBe(201);
  return id;
}

async function expenseCategoryId(page: Page): Promise<string> {
  const res = await page.request.get('/api/categories?kind=expense&status=active');
  expect(res.ok()).toBe(true);
  const found = flatten((await res.json()) as CategoryNode[]).find(
    (n) => n.kind === 'expense' && n.status === 'active',
  );
  expect(found).toBeDefined();
  return found?.id ?? '';
}

/** Opens a second, independent browser context signed in as the same user (device B). */
async function signInElsewhere(
  browser: Browser,
  user: TestUser,
): Promise<{ context: BrowserContext; page: Page }> {
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.goto('/entrar');
  await page.getByLabel(/correo/i).fill(user.email);
  await page.getByLabel(/contraseña/i).fill(user.password);
  await page.getByRole('button', { name: /entrar|iniciar sesión/i }).click();
  await expect(page).not.toHaveURL(/\/entrar/);
  return { context, page };
}

test.describe('TASK-151 Ajustes y sección General', () => {
  test('el hub de Ajustes lista las secciones y lleva a General', async ({ authedPage }) => {
    await authedPage.goto('/ajustes');
    const main = authedPage.getByRole('main');
    await expect(main.getByRole('heading', { name: 'Ajustes' })).toBeVisible();
    for (const section of ['General', 'Monedas y tipo de cambio', 'Registrar', 'Inicio']) {
      await expect(main.getByRole('link', { name: new RegExp(section) })).toBeVisible();
    }
    await main.getByRole('link', { name: /General/ }).click();
    await expect(authedPage).toHaveURL(/\/ajustes\/general$/);
    await expect(main.getByRole('heading', { name: 'General' })).toBeVisible();
  });

  test('RF-M9-01 los cambios se guardan solos, sin botón "Guardar"', async ({ authedPage }) => {
    await authedPage.goto('/ajustes/general');
    await expect(authedPage.getByRole('button', { name: 'Guardar' })).toHaveCount(0);

    await authedPage.getByLabel('Domingo').check();
    // Optimistic: it shows at once, and the server has it ~300 ms later.
    await expect(authedPage.getByLabel('Domingo')).toBeChecked();
    await expect.poll(async () => (await getSettings(authedPage)).weekStart).toBe('sunday');
  });

  test('RF-M9-01 Ajustes sincronizados: el tema oscuro elegido en un contexto se ve en otro al recargar', async ({
    browser,
    authedPage,
    testUser,
  }) => {
    await authedPage.goto('/ajustes/general');
    await authedPage.getByLabel('Oscuro').check();
    await expect(authedPage.locator('html')).toHaveClass(/dark/);
    await expect.poll(async () => (await getSettings(authedPage)).theme).toBe('dark');

    const other = await signInElsewhere(browser, testUser);
    try {
      await other.page.goto('/ajustes/general');
      await other.page.reload();
      await expect(other.page.locator('html')).toHaveClass(/dark/);
      await expect(other.page.getByLabel('Oscuro')).toBeChecked();
    } finally {
      await other.context.close();
    }
  });

  test('RF-M9-02 Formato de números: con "Bs 1,234.56", escribir "35.50" en Registrar guarda 35,50', async ({
    authedPage,
  }) => {
    await createAccount(authedPage, 'Efectivo');
    await authedPage.goto('/ajustes/general');
    await authedPage.getByLabel('Bs 1,234.56').check();
    await expect.poll(async () => (await getSettings(authedPage)).numberFormat).toBe('comma_dot');

    await authedPage.goto('/registrar');
    await authedPage.getByLabel('Monto').fill('35.50');
    await authedPage.getByRole('button', { name: 'Supermercado' }).click();
    await authedPage.getByRole('button', { name: 'Guardar', exact: true }).click();
    await expect(authedPage.getByText(/guardado/i).first()).toBeVisible();
    // 35.50 was read as 35 bolivianos 50 centavos and is shown in the chosen format.
    await expect(authedPage.getByText(/35\.50/).first()).toBeVisible();
    await expect(authedPage.getByText(/3\.550|3,550/)).toHaveCount(0);
  });

  test('RF-M9-03 con la fecha en AAAA-MM-DD, el movimiento la muestra en ese formato', async ({
    authedPage,
  }) => {
    const accountId = await createAccount(authedPage, 'Efectivo');
    const date = previousMonthStart();
    const id = randomUUID();
    const res = await authedPage.request.post('/api/transactions', {
      data: {
        kind: 'expense',
        id,
        accountId,
        categoryId: await expenseCategoryId(authedPage),
        amount: '20',
        date,
      },
    });
    expect(res.status()).toBe(201);

    await authedPage.goto('/ajustes/general');
    await authedPage.getByLabel('AAAA-MM-DD').check();
    await expect.poll(async () => (await getSettings(authedPage)).dateFormat).toBe('iso');

    await authedPage.goto(`/movimientos/${id}`);
    await expect(authedPage.getByText(date, { exact: true })).toBeVisible();
  });

  test('RF-M9-05 restablecer General vuelve a "Bs 1.234,56", con confirmación', async ({
    authedPage,
  }) => {
    await authedPage.goto('/ajustes/general');
    await authedPage.getByLabel('Bs 1,234.56').check();
    await authedPage.getByLabel('Oscuro').check();
    await expect.poll(async () => (await getSettings(authedPage)).numberFormat).toBe('comma_dot');

    await authedPage.getByRole('button', { name: 'Restablecer valores por defecto' }).click();
    // Cancelling leaves everything as it was.
    await authedPage.getByRole('button', { name: 'Cancelar' }).click();
    await expect(authedPage.getByLabel('Bs 1,234.56')).toBeChecked();

    await authedPage.getByRole('button', { name: 'Restablecer valores por defecto' }).click();
    await authedPage.getByRole('button', { name: 'Restablecer', exact: true }).click();
    await expect(authedPage.getByLabel('Bs 1.234,56')).toBeChecked();
    await expect(authedPage.getByLabel('Sistema')).toBeChecked();
    const settings = await getSettings(authedPage);
    expect(settings.numberFormat).toBe('dot_comma');
    expect(settings.theme).toBe('system');
  });
});
