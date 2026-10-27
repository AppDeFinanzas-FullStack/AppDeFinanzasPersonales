import { randomUUID } from 'node:crypto';

import type { Locator, Page } from '@playwright/test';

import { expect, test } from './fixtures/auth.js';

/**
 * TASK-243: the scenarios and rules of M2, M6 and M7 that the phases without new tests left
 * unnamed (plan §5.2, §5.4). They check what Registrar already does; each case seeds its data
 * through the API and drives the screen like the user.
 */

interface CategoryNode {
  id: string;
  name: string;
  children: CategoryNode[];
}

interface AccountItem {
  id: string;
  name: string;
  balance: string;
}

interface MovementItem {
  id: string;
  kind: string;
  category?: { name: string } | null;
  entries: { amount: string }[];
}

const BOLIVIA_OFFSET_MS = 4 * 60 * 60 * 1000;
const RECONNECT_TIMEOUT = 15_000;
const SHORTCUT_LIMIT = 12;

const pad = (n: number): string => String(n).padStart(2, '0');

/** A day of Bolivia as `YYYY-MM-DD`, `offset` days from today. */
function bolivianDay(offset = 0): string {
  const date = new Date(Date.now() - BOLIVIA_OFFSET_MS + offset * 86_400_000);
  return `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}`;
}

interface NewAccount {
  name: string;
  type?: string;
  currencyCode?: string;
  initialBalance?: string;
}

async function createAccount(page: Page, input: NewAccount): Promise<string> {
  const id = randomUUID();
  const res = await page.request.post('/api/accounts', {
    data: {
      id,
      type: input.type ?? 'cash',
      name: input.name,
      currencyCode: input.currencyCode ?? 'BOB',
      initialBalance: input.initialBalance ?? '500',
      initialBalanceDate: '2020-01-01',
      color: 'teal',
      icon: 'wallet',
    },
  });
  expect(res.status()).toBe(201);
  return id;
}

async function archiveAccount(page: Page, id: string): Promise<void> {
  const res = await page.request.post(`/api/accounts/${id}/archive`, {
    data: { confirmNonZero: true },
  });
  expect(res.status()).toBe(200);
}

async function accountsOf(page: Page): Promise<AccountItem[]> {
  const res = await page.request.get('/api/accounts');
  expect(res.ok()).toBe(true);
  return ((await res.json()) as { items: AccountItem[] }).items;
}

async function balanceOf(page: Page, id: string): Promise<string | undefined> {
  return (await accountsOf(page)).find((item) => item.id === id)?.balance;
}

/** An active expense category by name, among the roots and their subcategories. */
async function expenseCategory(page: Page, name: string): Promise<CategoryNode> {
  const res = await page.request.get('/api/categories?kind=expense&status=active');
  expect(res.ok()).toBe(true);
  const roots = (await res.json()) as CategoryNode[];
  for (const root of roots) {
    const found = [root, ...root.children].find((node) => node.name === name);
    if (found !== undefined) return found;
  }
  throw new Error(`the preloaded category ${name} does not exist`);
}

async function createExpense(
  page: Page,
  accountId: string,
  categoryId: string,
  amount: string,
): Promise<string> {
  const id = randomUUID();
  const res = await page.request.post('/api/transactions', {
    data: { kind: 'expense', id, accountId, categoryId, amount, date: bolivianDay() },
  });
  expect(res.status()).toBe(201);
  return id;
}

async function movementsOf(page: Page): Promise<MovementItem[]> {
  const res = await page.request.get(`/api/transactions?month=${bolivianDay().slice(0, 7)}`);
  expect(res.ok()).toBe(true);
  return ((await res.json()) as { items: MovementItem[] }).items;
}

/** A link of the navigation bar (bottom bar in the phone, side bar on the desktop). */
function navLink(page: Page, name: string): Locator {
  return page.getByRole('navigation').getByRole('link', { name, exact: true }).first();
}

function amountField(page: Page): Locator {
  return page.getByLabel('Monto', { exact: true });
}

function saveButton(page: Page): Locator {
  return page.getByRole('button', { name: 'Guardar', exact: true });
}

function kindButton(page: Page, name: string): Locator {
  return page.getByRole('group', { name: 'Tipo de movimiento' }).getByRole('button', { name });
}

/** The chip of a category in the grid of Registrar. */
function categoryChip(page: Page, name: string): Locator {
  return page
    .getByRole('group', { name: 'Categoría', exact: true })
    .getByRole('button', { name, exact: true });
}

function offlineNotice(page: Page): Locator {
  return page.getByText(/sin conexión/i).first();
}

/** The `register` draft of the user as stored (plan §4.2.3: `draft:{userId}:register`). */
async function registerDraft(page: Page): Promise<string> {
  return page.evaluate(() => {
    for (let index = 0; index < sessionStorage.length; index += 1) {
      const key = sessionStorage.key(index);
      if (key?.startsWith('draft:') === true && key.endsWith(':register')) {
        return sessionStorage.getItem(key) ?? '';
      }
    }
    return '';
  });
}

/** Waits until the draft holds the given fragment: it is saved 300 ms after the last change. */
async function expectDraftWith(page: Page, fragment: string): Promise<void> {
  await expect.poll(async () => registerDraft(page), { timeout: 10_000 }).toContain(fragment);
}

/** Opens Registrar from the navigation, as the user does. */
async function openRegister(page: Page): Promise<void> {
  await page.goto('/registrar');
  await expect(amountField(page)).toBeVisible();
}

/** The POSTs that create a movement (not the undo). */
function watchCreations(page: Page): { count: () => number } {
  let creations = 0;
  page.on('request', (request) => {
    if (request.method() === 'POST' && new URL(request.url()).pathname === '/api/transactions') {
      creations += 1;
    }
  });
  return { count: () => creations };
}

test.describe('TASK-243 M2 bloqueo sin conexión', () => {
  test('RF-M2-07 RF-M2-10 Bloqueo sin conexión conserva el borrador: al volver la conexión "35" sigue en Registrar', async ({
    authedPage,
    context,
  }) => {
    await createAccount(authedPage, { name: 'Efectivo' });
    await openRegister(authedPage);
    await amountField(authedPage).fill('35');
    await expectDraftWith(authedPage, '"amount":"35"');

    await context.setOffline(true);
    await expect(offlineNotice(authedPage)).toBeVisible();

    await context.setOffline(false);
    await expect(offlineNotice(authedPage)).toBeHidden({ timeout: RECONNECT_TIMEOUT });
    await expect(authedPage).toHaveURL(/\/registrar/);
    await expect(amountField(authedPage)).toHaveValue('35');
  });
});

test.describe('TASK-243 M7 borrador, atajos y deshacer', () => {
  test('RF-M2-10 Borrador al cambiar de pestaña: "120" sigue en el monto al ir a Cuentas y volver', async ({
    authedPage,
  }) => {
    await createAccount(authedPage, { name: 'Efectivo' });
    await openRegister(authedPage);
    await amountField(authedPage).fill('120');
    await expectDraftWith(authedPage, '"amount":"120"');

    await navLink(authedPage, 'Cuentas').click();
    await expect(authedPage).toHaveURL(/\/cuentas/);
    await navLink(authedPage, 'Registrar').click();
    await expect(authedPage).toHaveURL(/\/registrar/);

    await expect(amountField(authedPage)).toHaveValue('120');
  });

  test('RF-M7-02 El borrador conserva su tipo: el ingreso de "500" vuelve como ingreso, no como gasto vacío', async ({
    authedPage,
  }) => {
    await createAccount(authedPage, { name: 'Efectivo' });
    await openRegister(authedPage);
    await expect(kindButton(authedPage, 'Gasto')).toHaveAttribute('aria-pressed', 'true');
    await kindButton(authedPage, 'Ingreso').click();
    await amountField(authedPage).fill('500');
    await expectDraftWith(authedPage, '"kind":"income"');
    await expectDraftWith(authedPage, '"amount":"500"');

    await navLink(authedPage, 'Cuentas').click();
    await expect(authedPage).toHaveURL(/\/cuentas/);
    await navLink(authedPage, 'Registrar').click();
    await expect(authedPage).toHaveURL(/\/registrar/);

    await expect(amountField(authedPage)).toHaveValue('500');
    await expect(kindButton(authedPage, 'Ingreso')).toHaveAttribute('aria-pressed', 'true');
    await expect(kindButton(authedPage, 'Gasto')).toHaveAttribute('aria-pressed', 'false');
  });

  test('RF-M7-09 Atajo rellena sin guardar: el formulario queda completo y no se guarda hasta tocar "Guardar"', async ({
    authedPage,
  }) => {
    const cash = await createAccount(authedPage, { name: 'Efectivo' });
    const lunch = await expenseCategory(authedPage, 'Restaurantes');
    const shortcut = await authedPage.request.post('/api/shortcuts', {
      data: {
        id: randomUUID(),
        name: 'Almuerzo',
        kind: 'expense',
        amount: '35.00',
        accountId: cash,
        categoryId: lunch.id,
      },
    });
    expect(shortcut.status()).toBe(201);
    const creations = watchCreations(authedPage);

    await openRegister(authedPage);
    await authedPage.getByRole('button', { name: 'Almuerzo', exact: true }).click();

    // The form is complete: amount, account and category; "Guardar" is ready.
    await expect(amountField(authedPage)).toHaveValue(/^35([.,]00)?$/);
    await expect(
      authedPage.locator('form').getByText('Efectivo', { exact: true }).first(),
    ).toBeVisible();
    await expect(saveButton(authedPage)).toBeEnabled();
    expect(creations.count()).toBe(0);
    expect(await movementsOf(authedPage)).toEqual([]);

    await saveButton(authedPage).click();
    await expect(authedPage.getByText(/Gasto de .*35,00 guardado/)).toBeVisible();
    expect(creations.count()).toBe(1);
    const saved = await movementsOf(authedPage);
    expect(saved).toHaveLength(1);
    expect(saved[0]?.category?.name).toBe('Restaurantes');
    expect(saved[0]?.entries.map((entry) => entry.amount)).toEqual(['-35.00']);
  });

  test('RF-M7-07 Deshacer después de guardar: "Deshacer" dentro de los 10 segundos elimina el gasto y restablece el saldo', async ({
    authedPage,
  }) => {
    const cash = await createAccount(authedPage, { name: 'Efectivo' });
    await openRegister(authedPage);
    await amountField(authedPage).fill('35');
    await categoryChip(authedPage, 'Comida').click();
    await saveButton(authedPage).click();

    await expect(authedPage.getByText(/Gasto de .*35,00 guardado/)).toBeVisible();
    expect(await balanceOf(authedPage, cash)).toBe('465.00');
    expect(await movementsOf(authedPage)).toHaveLength(1);

    const undone = authedPage.waitForResponse(
      (res) =>
        res.request().method() === 'POST' &&
        new URL(res.url()).pathname === '/api/transactions/undo',
    );
    await authedPage.getByRole('button', { name: 'Deshacer', exact: true }).click();
    expect((await undone).status()).toBe(204);

    await expect(authedPage.getByRole('button', { name: 'Deshacer', exact: true })).toHaveCount(0);
    expect(await movementsOf(authedPage)).toEqual([]);
    expect(await balanceOf(authedPage, cash)).toBe('500.00');
  });

  test('EC-M6-06 al cambiar de pantalla durante los 10 segundos de "Deshacer" la eliminación queda definitiva', async ({
    authedPage,
  }) => {
    const cash = await createAccount(authedPage, { name: 'Efectivo' });
    const food = await expenseCategory(authedPage, 'Comida');
    const spent = await createExpense(authedPage, cash, food.id, '35');
    expect(await balanceOf(authedPage, cash)).toBe('465.00');

    await authedPage.goto(`/movimientos/${spent}`);
    await authedPage.getByRole('button', { name: 'Eliminar', exact: true }).click();
    await expect(authedPage).toHaveURL(/\/movimientos$/);
    const undo = authedPage.getByRole('button', { name: 'Deshacer', exact: true });
    await expect(undo).toBeVisible();

    await navLink(authedPage, 'Cuentas').click();
    await expect(authedPage).toHaveURL(/\/cuentas/);
    await expect(undo).toHaveCount(0);

    // Back in Movimientos the option does not come back: the deletion is final.
    await navLink(authedPage, 'Movimientos').click();
    await expect(authedPage).toHaveURL(/\/movimientos/);
    await expect(undo).toHaveCount(0);
    const gone = await authedPage.request.get(`/api/transactions/${spent}`);
    expect(gone.status()).toBe(404);
    expect(await balanceOf(authedPage, cash)).toBe('500.00');
  });
});

test.describe('TASK-243 M7 formulario de Registrar', () => {
  test('RF-M7-05 la fecha ofrece "Hoy" marcada, "Ayer" y "Calendario", sin fechas futuras', async ({
    authedPage,
  }) => {
    await createAccount(authedPage, { name: 'Efectivo' });
    await openRegister(authedPage);

    const today = authedPage.getByRole('button', { name: 'Hoy', exact: true });
    const yesterday = authedPage.getByRole('button', { name: 'Ayer', exact: true });
    const calendar = authedPage.getByRole('button', { name: 'Calendario', exact: true });
    await expect(today).toHaveAttribute('aria-pressed', 'true');
    await expect(yesterday).toHaveAttribute('aria-pressed', 'false');
    await expect(calendar).toBeVisible();

    await yesterday.click();
    await expect(yesterday).toHaveAttribute('aria-pressed', 'true');
    await expect(today).toHaveAttribute('aria-pressed', 'false');
    await today.click();
    await expect(today).toHaveAttribute('aria-pressed', 'true');

    // The calendar disables every day after today.
    await calendar.click();
    const picker = authedPage.getByRole('dialog', { name: /fecha de hoy o anterior/i });
    await expect(picker).toBeVisible();
    const cellOf = (day: string): Locator => picker.locator(`[data-day="${day}"]`);
    const tomorrow = bolivianDay(1);
    if ((await cellOf(tomorrow).count()) === 0) {
      await picker.getByRole('button', { name: /siguiente|next/i }).click();
    }
    await expect(cellOf(tomorrow).getByRole('button')).toBeDisabled();
    await expect(cellOf(bolivianDay(2)).getByRole('button')).toBeDisabled();
    await expect(cellOf(bolivianDay(0)).getByRole('button')).toBeEnabled();
  });

  test('RF-M7-06 "Guardar" se habilita con monto mayor que 0 y categoría, o con origen y destino distintos', async ({
    authedPage,
  }) => {
    await createAccount(authedPage, { name: 'Efectivo' });
    await createAccount(authedPage, { name: 'Banco', type: 'bank' });
    await openRegister(authedPage);

    // Gasto: needs the amount and the category.
    await expect(saveButton(authedPage)).toBeDisabled();
    await amountField(authedPage).fill('25');
    await expect(saveButton(authedPage)).toBeDisabled();
    await categoryChip(authedPage, 'Comida').click();
    await expect(saveButton(authedPage)).toBeEnabled();
    await amountField(authedPage).fill('0');
    await expect(saveButton(authedPage)).toBeDisabled();
    await amountField(authedPage).fill('0,50');
    await expect(saveButton(authedPage)).toBeEnabled();

    // Ingreso: the category belongs to the kind, so it has to be chosen again.
    await kindButton(authedPage, 'Ingreso').click();
    await expect(saveButton(authedPage)).toBeDisabled();
    await categoryChip(authedPage, 'Sueldo').click();
    await expect(saveButton(authedPage)).toBeEnabled();

    // Transferencia: no category, but different origin and destination.
    await kindButton(authedPage, 'Transferencia').click();
    await amountField(authedPage).fill('10');
    const from = authedPage.getByLabel('Desde', { exact: true });
    const to = authedPage.getByLabel('Hacia', { exact: true });
    await expect(from).not.toHaveValue(await to.inputValue());
    await expect(saveButton(authedPage)).toBeEnabled();
    await to.selectOption(await from.inputValue());
    await expect(saveButton(authedPage)).toBeDisabled();
    await expect(authedPage.getByText(/cuenta de destino distinta/i)).toBeVisible();
  });

  test('EC-M7-01 sin cuentas Registrar muestra "Crea tu primera cuenta" con un formulario mínimo en la misma pantalla', async ({
    authedPage,
  }) => {
    await authedPage.goto('/registrar');
    await expect(authedPage.getByRole('heading', { name: 'Crea tu primera cuenta' })).toBeVisible();
    await expect(authedPage.getByLabel('Nombre', { exact: true })).toBeVisible();
    await expect(authedPage.getByLabel('Tipo', { exact: true })).toBeVisible();
    await expect(authedPage.getByLabel('Moneda', { exact: true })).toBeVisible();
    await expect(authedPage.getByLabel('Saldo actual')).toBeVisible();
    await expect(amountField(authedPage)).toHaveCount(0);

    await authedPage.getByLabel('Nombre', { exact: true }).fill('Mi efectivo');
    await authedPage.getByLabel('Saldo actual').fill('100');
    await authedPage.getByRole('button', { name: 'Crear cuenta' }).click();

    // Same screen: now the form to register shows, on the new account.
    await expect(authedPage).toHaveURL(/\/registrar/);
    await expect(amountField(authedPage)).toBeVisible();
    await expect(authedPage.getByRole('heading', { name: 'Crea tu primera cuenta' })).toHaveCount(
      0,
    );
    await expect(
      authedPage.locator('form').getByText('Mi efectivo', { exact: true }).first(),
    ).toBeVisible();
  });

  test('EC-M7-02 un gasto que deja el efectivo en negativo muestra el error y el formulario no se limpia', async ({
    authedPage,
  }) => {
    const cash = await createAccount(authedPage, { name: 'Efectivo', initialBalance: '30' });
    await openRegister(authedPage);
    await amountField(authedPage).fill('35');
    await categoryChip(authedPage, 'Comida').click();
    await saveButton(authedPage).click();

    await expect(
      authedPage.getByRole('alert').filter({ hasText: /quedaría en .*5,00/ }),
    ).toBeVisible();
    await expect(amountField(authedPage)).toHaveValue('35');
    await expect(categoryChip(authedPage, 'Comida')).toHaveAttribute('aria-pressed', 'true');
    await expect(authedPage.getByText(/Gasto de .* guardado/)).toHaveCount(0);
    expect(await balanceOf(authedPage, cash)).toBe('30.00');
    expect(await movementsOf(authedPage)).toEqual([]);
  });

  test('EC-M7-04 sin ninguna tasa y con la cuenta en dólares se pide el valor en ese momento', async ({
    authedPage,
  }) => {
    const usd = await createAccount(authedPage, {
      name: 'Dólares',
      type: 'bank',
      currencyCode: 'USD',
      initialBalance: '100',
    });
    // The API answers that no rate exists the first time (EC-M3-02); the resend carries the value.
    const bodies: Record<string, unknown>[] = [];
    await authedPage.route('**/api/transactions', async (route) => {
      const request = route.request();
      if (request.method() !== 'POST') {
        await route.fallback();
        return;
      }
      bodies.push(request.postDataJSON() as Record<string, unknown>);
      if (bodies.length === 1) {
        await route.fulfill({
          status: 409,
          contentType: 'application/problem+json',
          body: JSON.stringify({
            type: '/problems/RATE_REQUIRED',
            title: 'RATE_REQUIRED',
            status: 409,
            code: 'RATE_REQUIRED',
            traceId: 'e2e',
          }),
        });
        return;
      }
      await route.continue();
    });

    await openRegister(authedPage);
    await amountField(authedPage).fill('10');
    await categoryChip(authedPage, 'Comida').click();
    await saveButton(authedPage).click();

    const dialog = authedPage.getByRole('dialog');
    await expect(
      dialog.getByText('No pudimos obtener el dólar. ¿A cuánto lo tomamos?'),
    ).toBeVisible();
    await dialog.getByLabel('Bs por $ 1').fill('10,30');
    await dialog.getByRole('button', { name: 'Usar este valor' }).click();

    await expect(authedPage.getByText(/Gasto de .*10,00 guardado/)).toBeVisible();
    expect(bodies).toHaveLength(2);
    expect(bodies[1]?.['manualUsdRate']).toBe('10.30');
    expect(bodies[1]?.['id']).toBe(bodies[0]?.['id']);
    // The value is the rate of the movement and the manual value in use.
    const moved = (await movementsOf(authedPage))[0];
    expect(moved?.entries.map((entry) => entry.amount)).toEqual(['-10.00']);
    const rates = await authedPage.request.get('/api/rates/current');
    expect(rates.ok()).toBe(true);
    const inUse = ((await rates.json()) as { inUse: { kind: string; value: string | null } }).inUse;
    expect(inUse).toMatchObject({ kind: 'manual', value: '10.30' });
    expect(await balanceOf(authedPage, usd)).toBe('90.00');
  });

  test('EC-M7-05 la cuenta por defecto se archiva: el ajuste se limpia y Registrar usa la primera cuenta activa', async ({
    authedPage,
  }) => {
    const preferred = await createAccount(authedPage, { name: 'Preferida' });
    await createAccount(authedPage, { name: 'Otra' });
    const set = await authedPage.request.patch('/api/settings', {
      data: { defaultAccountId: preferred },
    });
    expect(set.status()).toBe(200);
    await openRegister(authedPage);
    await expect(
      authedPage.locator('form').getByText('Preferida', { exact: true }).first(),
    ).toBeVisible();

    await archiveAccount(authedPage, preferred);

    const settings = await authedPage.request.get('/api/settings');
    expect(
      ((await settings.json()) as { defaultAccountId: string | null }).defaultAccountId,
    ).toBeNull();
    await openRegister(authedPage);
    await expect(
      authedPage.locator('form').getByText('Otra', { exact: true }).first(),
    ).toBeVisible();
    await expect(authedPage.getByText('Preferida')).toHaveCount(0);
  });

  test('EC-M7-06 con 12 atajos "Guardar como atajo" informa el límite y ofrece gestionar los atajos', async ({
    authedPage,
  }) => {
    const cash = await createAccount(authedPage, { name: 'Efectivo' });
    const lunch = await expenseCategory(authedPage, 'Restaurantes');
    for (let index = 1; index <= SHORTCUT_LIMIT; index += 1) {
      const res = await authedPage.request.post('/api/shortcuts', {
        data: {
          id: randomUUID(),
          name: `Atajo ${index}`,
          kind: 'expense',
          accountId: cash,
          categoryId: lunch.id,
        },
      });
      expect(res.status()).toBe(201);
    }

    await openRegister(authedPage);
    await amountField(authedPage).fill('12');
    await categoryChip(authedPage, 'Comida').click();
    await authedPage.getByRole('button', { name: 'Más opciones' }).click();
    await authedPage.getByRole('button', { name: 'Guardar como atajo' }).click();
    const dialog = authedPage.getByRole('dialog');
    await dialog.getByLabel('Nombre del atajo').fill('Atajo 13');
    await dialog.getByRole('button', { name: 'Guardar atajo' }).click();

    await expect(dialog.getByText(/Ya tienes 12 atajos/)).toBeVisible();
    const manage = dialog.getByRole('link', { name: 'Gestionar mis atajos' });
    await expect(manage).toBeVisible();
    await expect(manage).toHaveAttribute('href', '/ajustes');
    const list = await authedPage.request.get('/api/shortcuts');
    expect(((await list.json()) as { items: unknown[] }).items).toHaveLength(SHORTCUT_LIMIT);
  });

  test('EC-M7-07 sin categorías del tipo elegido "Ver todas" aparece vacío con la acción "Crear categoría"', async ({
    authedPage,
  }) => {
    await createAccount(authedPage, { name: 'Efectivo' });
    // No active category of income: the list of the full sheet answers empty.
    await authedPage.route('**/api/categories?*', async (route) => {
      if (new URL(route.request().url()).searchParams.get('kind') === 'income') {
        await route.fulfill({ status: 200, contentType: 'application/json', body: '[]' });
        return;
      }
      await route.fallback();
    });

    await openRegister(authedPage);
    await kindButton(authedPage, 'Ingreso').click();
    await authedPage.getByRole('button', { name: 'Ver todas' }).click();

    const sheet = authedPage.getByRole('dialog');
    await expect(sheet.getByText('No tienes categorías de ingreso activas.')).toBeVisible();
    const create = sheet.getByRole('link', { name: 'Crear categoría' });
    await expect(create).toBeVisible();
    await expect(create).toHaveAttribute('href', '/categorias/nueva');
  });

  test('EC-M7-08 un borrador que apunta a una cuenta archivada desde otro dispositivo vacía el campo y lo marca', async ({
    authedPage,
  }) => {
    await createAccount(authedPage, { name: 'Efectivo' });
    const savings = await createAccount(authedPage, { name: 'Ahorro viejo', type: 'savings' });
    await openRegister(authedPage);
    await authedPage.getByRole('button', { name: 'Más opciones' }).click();
    await authedPage.getByLabel('Otra cuenta').selectOption(savings);
    await amountField(authedPage).fill('15');
    await expectDraftWith(authedPage, `"accountId":"${savings}"`);

    // Another device archives the account the draft points to.
    await archiveAccount(authedPage, savings);
    await authedPage.reload();
    await expect(amountField(authedPage)).toBeVisible();

    await expect(
      authedPage.getByText(
        'La cuenta que habías elegido ya no está activa. Revisa la cuenta antes de guardar.',
      ),
    ).toBeVisible();
    await expect(amountField(authedPage)).toHaveValue('15');
    await authedPage.getByRole('button', { name: 'Más opciones' }).click();
    const options = authedPage.getByLabel('Otra cuenta').locator('option');
    await expect(options).toHaveCount(1);
    await expect(options.first()).toHaveText(/Efectivo/);
  });
});
