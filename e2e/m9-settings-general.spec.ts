import { randomUUID } from 'node:crypto';

import type { Browser, BrowserContext, Page } from '@playwright/test';

import { expect, test } from './fixtures/auth.js';
import type { TestUser } from './fixtures/auth.js';

interface Settings {
  numberFormat: string;
  dateFormat: string;
  weekStart: string;
  theme: string;
}

interface CategoryNode {
  id: string;
  kind: string;
  status: string;
  children: CategoryNode[];
}

interface RegisterContext {
  grid: { expense: { id: string; name: string }[] };
}

interface TransactionList {
  items: { id: string; entries: { amount: string }[] }[];
}

const BOLIVIA_OFFSET_MS = 4 * 60 * 60 * 1000;

const pad = (n: number): string => String(n).padStart(2, '0');

function bolivianToday(): { y: number; m: number } {
  const now = new Date(Date.now() - BOLIVIA_OFFSET_MS);
  return { y: now.getUTCFullYear(), m: now.getUTCMonth() + 1 };
}

/** The month `back` months before the current one in Bolivia, as `{ y, m }`. */
function monthsBack(back: number): { y: number; m: number } {
  const { y, m } = bolivianToday();
  const index = y * 12 + (m - 1) - back;
  return { y: Math.floor(index / 12), m: (index % 12) + 1 };
}

function currentMonth(): string {
  const { y, m } = bolivianToday();
  return `${y}-${pad(m)}`;
}

/** First day of the previous calendar month: always older than the last week. */
function previousMonthStart(): string {
  const { y, m } = monthsBack(1);
  return `${y}-${pad(m)}-01`;
}

function twoMonthsAgoStart(): string {
  const { y, m } = monthsBack(2);
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
      initialBalanceDate: twoMonthsAgoStart(),
      color: 'teal',
      icon: 'wallet',
    },
  });
  expect(res.status()).toBe(201);
  return id;
}

async function anyExpenseCategoryId(page: Page): Promise<string> {
  const res = await page.request.get('/api/categories?kind=expense&status=active');
  expect(res.ok()).toBe(true);
  const found = flatten((await res.json()) as CategoryNode[]).find(
    (n) => n.kind === 'expense' && n.status === 'active',
  );
  expect(found).toBeDefined();
  return found?.id ?? '';
}

/** Opens a second, independent browser context signed in as the same user (another device). */
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
  test('TASK-151 /ajustes lista las secciones y lleva a /ajustes/general', async ({
    authedPage,
  }) => {
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

  test('TASK-151 /ajustes/general muestra formatos, primer día de la semana y tema', async ({
    authedPage,
  }) => {
    await authedPage.goto('/ajustes/general');
    await expect(authedPage.getByText('Formato de números')).toBeVisible();
    await expect(authedPage.getByText('Formato de fecha')).toBeVisible();
    await expect(authedPage.getByText('Primer día de la semana')).toBeVisible();
    await expect(authedPage.getByText('Tema', { exact: true })).toBeVisible();
    // The defaults: "Bs 1.234,56", day first, Monday and the system theme.
    await expect(authedPage.getByLabel('Bs 1.234,56')).toBeChecked();
    await expect(authedPage.getByLabel('DD/MM/AAAA')).toBeChecked();
    await expect(authedPage.getByLabel('Lunes')).toBeChecked();
    await expect(authedPage.getByLabel('Sistema')).toBeChecked();
  });

  test('RF-M9-01 los cambios se guardan solos, sin botón "Guardar"', async ({ authedPage }) => {
    await authedPage.goto('/ajustes/general');
    await expect(authedPage.getByRole('button', { name: 'Guardar' })).toHaveCount(0);

    await authedPage.getByLabel('Domingo').check();
    // Optimistic: it shows at once, and the server has it a moment later.
    await expect(authedPage.getByLabel('Domingo')).toBeChecked();
    await expect.poll(async () => (await getSettings(authedPage)).weekStart).toBe('sunday');
  });

  test('RF-M9-01 cada cambio se guarda 300 ms después, no al instante', async ({
    authedPage,
  }) => {
    await authedPage.goto('/ajustes/general');
    await expect(authedPage.getByLabel('Lunes')).toBeChecked();

    const requested = authedPage.waitForRequest(
      (request) => request.method() === 'PATCH' && request.url().endsWith('/api/settings'),
    );
    const clickedAt = Date.now();
    await authedPage.getByLabel('Domingo').check();
    await requested;
    expect(Date.now() - clickedAt).toBeGreaterThanOrEqual(250);
  });

  test('RF-M9-01 si el guardado falla, el ajuste vuelve al valor anterior', async ({
    authedPage,
  }) => {
    await authedPage.goto('/ajustes/general');
    await expect(authedPage.getByLabel('Lunes')).toBeChecked();

    await authedPage.route('**/api/settings', async (route) => {
      if (route.request().method() === 'PATCH') {
        await route.abort('failed');
      } else {
        await route.continue();
      }
    });

    await authedPage.getByLabel('Domingo').check();
    // A dropped request also raises the offline notice, which is another alert.
    await expect(
      authedPage.getByRole('alert').filter({ hasText: 'No se pudo guardar el cambio' }),
    ).toBeVisible();
    await expect(authedPage.getByLabel('Lunes')).toBeChecked();
    await expect(authedPage.getByLabel('Domingo')).not.toBeChecked();
    expect((await getSettings(authedPage)).weekStart).toBe('monday');
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

  test('EC-M9-01 gana el último guardado y el otro dispositivo lo refleja al actualizar', async ({
    browser,
    authedPage,
    testUser,
  }) => {
    await authedPage.goto('/ajustes/general');
    const other = await signInElsewhere(browser, testUser);
    try {
      await other.page.goto('/ajustes/general');
      await expect(other.page.getByLabel('Lunes')).toBeChecked();
      await expect(authedPage.getByLabel('Lunes')).toBeChecked();

      // Device A saves first; device B refreshes, shows it, and then saves: B is the last saved.
      await authedPage.getByLabel('Domingo').check();
      await expect.poll(async () => (await getSettings(authedPage)).weekStart).toBe('sunday');
      await other.page.reload();
      await expect(other.page.getByLabel('Domingo')).toBeChecked();
      await other.page.getByLabel('Lunes').check();
      await expect(other.page.getByLabel('Lunes')).toBeChecked();
      await expect
        .poll(async () => (await getSettings(other.page)).weekStart, { timeout: 10_000 })
        .toBe('monday');

      // Device A shows the last saved one when it refreshes.
      await authedPage.reload();
      await expect(authedPage.getByLabel('Lunes')).toBeChecked();
      await expect(authedPage.getByLabel('Domingo')).not.toBeChecked();
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

    const context = await authedPage.request.get('/api/register/context');
    expect(context.ok()).toBe(true);
    const chip = ((await context.json()) as RegisterContext).grid.expense[0];
    expect(chip).toBeDefined();

    await authedPage.goto('/registrar');
    await authedPage.getByLabel('Monto').fill('35.50');
    await authedPage.getByRole('button', { name: chip?.name ?? '' }).first().click();
    await authedPage.getByRole('button', { name: 'Guardar', exact: true }).click();

    // The symbol goes before the amount, in the chosen format (RF-M9-02).
    await expect(authedPage.getByText(/Gasto de Bs 35\.50 guardado/).first()).toBeVisible();

    // 35.50 was read as thirty-five bolivianos with fifty centavos, not as 3550.
    const list = await authedPage.request.get(`/api/transactions?month=${currentMonth()}`);
    expect(list.ok()).toBe(true);
    const items = ((await list.json()) as TransactionList).items;
    expect(items).toHaveLength(1);
    expect(Math.abs(Number(items[0]?.entries[0]?.amount))).toBe(35.5);
  });

  test('RF-M9-02 con "Bs 1.234,56", el símbolo va antes del monto y separado por un espacio', async ({
    authedPage,
  }) => {
    await createAccount(authedPage, 'Efectivo');
    const context = await authedPage.request.get('/api/register/context');
    const chip = ((await context.json()) as RegisterContext).grid.expense[0];
    expect(chip).toBeDefined();

    await authedPage.goto('/registrar');
    await authedPage.getByLabel('Monto').fill('35,00');
    await authedPage.getByRole('button', { name: chip?.name ?? '' }).first().click();
    await authedPage.getByRole('button', { name: 'Guardar', exact: true }).click();
    await expect(authedPage.getByText(/Gasto de Bs 35,00 guardado/).first()).toBeVisible();
  });

  test('RF-M9-03 con la fecha en AAAA-MM-DD, la lista de movimientos usa ese formato', async ({
    authedPage,
  }) => {
    const accountId = await createAccount(authedPage, 'Efectivo');
    const date = previousMonthStart();
    const [year, month, day] = date.split('-');
    const created = await authedPage.request.post('/api/transactions', {
      data: {
        kind: 'expense',
        id: randomUUID(),
        accountId,
        categoryId: await anyExpenseCategoryId(authedPage),
        amount: '20',
        date,
      },
    });
    expect(created.status()).toBe(201);
    const listUrl = `/movimientos?mes=${year}-${month}`;

    await authedPage.goto(listUrl);
    await expect(authedPage.getByText(`${day}/${month}/${year}`).first()).toBeVisible();

    await authedPage.goto('/ajustes/general');
    await authedPage.getByLabel('AAAA-MM-DD').check();
    await expect.poll(async () => (await getSettings(authedPage)).dateFormat).toBe('iso');

    await authedPage.goto(listUrl);
    await expect(authedPage.getByText(date).first()).toBeVisible();
    await expect(authedPage.getByText(`${day}/${month}/${year}`)).toHaveCount(0);
  });

  test('RF-M9-05 restablecer General vuelve a "Bs 1.234,56", con confirmación', async ({
    authedPage,
  }) => {
    await authedPage.goto('/ajustes/general');
    await authedPage.getByLabel('Bs 1,234.56').check();
    await authedPage.getByLabel('Oscuro').check();
    await expect.poll(async () => (await getSettings(authedPage)).numberFormat).toBe('comma_dot');
    await expect.poll(async () => (await getSettings(authedPage)).theme).toBe('dark');

    // Cancelling the confirmation leaves everything as it was.
    await authedPage.getByRole('button', { name: 'Restablecer valores por defecto' }).click();
    await authedPage.getByRole('button', { name: 'Cancelar' }).click();
    await expect(authedPage.getByLabel('Bs 1,234.56')).toBeChecked();
    expect((await getSettings(authedPage)).numberFormat).toBe('comma_dot');

    await authedPage.getByRole('button', { name: 'Restablecer valores por defecto' }).click();
    await authedPage.getByRole('button', { name: 'Restablecer', exact: true }).click();
    await expect(authedPage.getByLabel('Bs 1.234,56')).toBeChecked();
    await expect(authedPage.getByLabel('Sistema')).toBeChecked();

    const settings = await getSettings(authedPage);
    expect(settings.numberFormat).toBe('dot_comma');
    expect(settings.theme).toBe('system');
  });

  test('RF-M9-05 restablecer General no toca cuentas ni movimientos', async ({ authedPage }) => {
    const accountId = await createAccount(authedPage, 'Efectivo');
    const transactionId = randomUUID();
    const created = await authedPage.request.post('/api/transactions', {
      data: {
        kind: 'expense',
        id: transactionId,
        accountId,
        categoryId: await anyExpenseCategoryId(authedPage),
        amount: '20',
        date: previousMonthStart(),
      },
    });
    expect(created.status()).toBe(201);

    await authedPage.goto('/ajustes/general');
    await authedPage.getByLabel('Domingo').check();
    await expect.poll(async () => (await getSettings(authedPage)).weekStart).toBe('sunday');
    await authedPage.getByRole('button', { name: 'Restablecer valores por defecto' }).click();
    await authedPage.getByRole('button', { name: 'Restablecer', exact: true }).click();
    await expect(authedPage.getByLabel('Lunes')).toBeChecked();

    const accounts = await authedPage.request.get('/api/accounts');
    expect(accounts.ok()).toBe(true);
    expect(await accounts.text()).toContain(accountId);
    const transaction = await authedPage.request.get(`/api/transactions/${transactionId}`);
    expect(transaction.ok()).toBe(true);
  });
});
