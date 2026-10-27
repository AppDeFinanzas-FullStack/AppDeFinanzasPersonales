import { randomUUID } from 'node:crypto';

import type { Locator, Page } from '@playwright/test';

import { expect, test } from './fixtures/auth.js';

/**
 * TASK-243: the scenarios and rules of M4 and M5 that the phases without new tests left unnamed
 * (plan §5.2, §5.4). They check what Cuentas and Categorías already do; each case seeds its data
 * through the API and drives the screens like the user.
 */

interface CategoryNode {
  id: string;
  name: string;
  isSystem: boolean;
  children: CategoryNode[];
}

interface AccountItem {
  id: string;
  name: string;
  balance: string;
  status: string;
}

interface MovementItem {
  id: string;
  kind: string;
}

const BOLIVIA_OFFSET_MS = 4 * 60 * 60 * 1000;
const BATCH = 8;

const today = (): string => new Date(Date.now() - BOLIVIA_OFFSET_MS).toISOString().slice(0, 10);
const thisMonth = (): string => today().slice(0, 7);

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

async function accountsOf(page: Page, status = 'active'): Promise<AccountItem[]> {
  const res = await page.request.get(`/api/accounts?status=${status}`);
  expect(res.ok()).toBe(true);
  return ((await res.json()) as { items: AccountItem[] }).items;
}

async function categoryTree(page: Page): Promise<CategoryNode[]> {
  const res = await page.request.get('/api/categories?kind=expense&status=active');
  expect(res.ok()).toBe(true);
  return (await res.json()) as CategoryNode[];
}

/** An active expense category by name, among the roots and their subcategories. */
async function expenseCategory(page: Page, name: string): Promise<CategoryNode> {
  for (const root of await categoryTree(page)) {
    const found = [root, ...root.children].find((node) => node.name === name);
    if (found !== undefined) return found;
  }
  throw new Error(`the preloaded category ${name} does not exist`);
}

async function createExpenses(
  page: Page,
  accountId: string,
  categoryId: string,
  count: number,
): Promise<void> {
  for (let start = 0; start < count; start += BATCH) {
    const batch = Array.from({ length: Math.min(BATCH, count - start) }, async () => {
      const res = await page.request.post('/api/transactions', {
        data: {
          kind: 'expense',
          id: randomUUID(),
          accountId,
          categoryId,
          amount: '1',
          date: today(),
        },
      });
      expect(res.status()).toBe(201);
    });
    await Promise.all(batch);
  }
}

async function countIn(page: Page, categoryId: string): Promise<number> {
  const res = await page.request.get(
    `/api/transactions?categoryId=${categoryId}&month=${thisMonth()}&limit=100`,
  );
  expect(res.ok()).toBe(true);
  return ((await res.json()) as { items: MovementItem[] }).items.length;
}

async function kindTotals(page: Page): Promise<{ income: string; expense: string }> {
  const res = await page.request.get(`/api/transactions/summary?month=${thisMonth()}`);
  expect(res.ok()).toBe(true);
  return (await res.json()) as { income: string; expense: string };
}

function balanceOf(page: Page): Locator {
  return page.getByTestId('account-balance');
}

/** The names of the accounts of the list, group by group, in the order the screen shows them. */
async function listedNames(page: Page): Promise<string[]> {
  return page.locator('li[data-testid^="account-"] a').allTextContents();
}

test.describe('TASK-243 M4 ajuste de saldo', () => {
  test('RF-M4-05 Ajuste de saldo: el saldo real de Bs 1.250,00 crea un Ajuste de +50,00 y los ingresos no cambian', async ({
    authedPage,
  }) => {
    const bank = await createAccount(authedPage, {
      name: 'Banco',
      type: 'bank',
      initialBalance: '1200',
    });
    const before = await kindTotals(authedPage);

    await authedPage.goto(`/cuentas/${bank}`);
    await expect(balanceOf(authedPage)).toHaveText(/Bs\s?1\.200,00/);
    await authedPage.getByRole('button', { name: 'Ajustar saldo' }).click();
    const dialog = authedPage.getByRole('dialog', { name: 'Ajustar saldo' });
    await dialog.getByLabel('Saldo real').fill('1250');
    await dialog.getByRole('button', { name: 'Ajustar', exact: true }).click();
    await expect(dialog).toBeHidden();

    await expect(balanceOf(authedPage)).toHaveText(/Bs\s?1\.250,00/);
    await expect(authedPage.getByText('Ajuste de saldo').first()).toBeVisible();
    const adjustments = await authedPage.request.get('/api/transactions?kind=adjustment');
    const items = ((await adjustments.json()) as { items: { entries: { amount: string }[] }[] })
      .items;
    expect(items.map((item) => item.entries.map((entry) => entry.amount))).toEqual([['50.00']]);
    expect(await kindTotals(authedPage)).toEqual(before);
  });

  test('EC-M4-08 ajustar el saldo al mismo valor informa "El saldo ya coincide" y no crea ningún ajuste', async ({
    authedPage,
  }) => {
    const bank = await createAccount(authedPage, {
      name: 'Banco',
      type: 'bank',
      initialBalance: '1200',
    });

    await authedPage.goto(`/cuentas/${bank}`);
    await authedPage.getByRole('button', { name: 'Ajustar saldo' }).click();
    const dialog = authedPage.getByRole('dialog', { name: 'Ajustar saldo' });
    await dialog.getByLabel('Saldo real').fill('1200');
    await dialog.getByRole('button', { name: 'Ajustar', exact: true }).click();

    await expect(dialog.getByText(/El saldo ya coincide/)).toBeVisible();
    const adjustments = await authedPage.request.get('/api/transactions?kind=adjustment');
    expect(((await adjustments.json()) as { items: unknown[] }).items).toEqual([]);
    expect((await accountsOf(authedPage)).find((item) => item.id === bank)?.balance).toBe(
      '1200.00',
    );
  });
});

test.describe('TASK-243 M4 ciclo de vida de las cuentas', () => {
  test('RF-M4-09 una cuenta archivada no aparece en los selectores ni suma en el total, y conserva su historia', async ({
    authedPage,
  }) => {
    const keep = await createAccount(authedPage, { name: 'Efectivo', initialBalance: '200' });
    const old = await createAccount(authedPage, {
      name: 'Banco viejo',
      type: 'bank',
      initialBalance: '300',
    });
    const food = await expenseCategory(authedPage, 'Comida');
    await createExpenses(authedPage, old, food.id, 1);
    expect(keep).not.toBe(old);

    await authedPage.goto(`/cuentas/${old}`);
    await authedPage.getByRole('button', { name: 'Archivar', exact: true }).click();
    const confirm = authedPage.getByRole('alertdialog');
    await expect(confirm.getByText('¿Archivar Banco viejo?')).toBeVisible();
    await confirm.getByRole('button', { name: 'Archivar', exact: true }).click();
    await expect(authedPage.getByText('Archivada', { exact: true })).toBeVisible();

    // Out of the list and of the net worth; in the archived ones, with its history.
    await authedPage.goto('/cuentas');
    await expect(authedPage.getByRole('link', { name: 'Efectivo', exact: true })).toBeVisible();
    await expect(authedPage.getByRole('link', { name: 'Banco viejo' })).toHaveCount(0);
    await expect(authedPage.getByText(/Bs\s?200,00/).first()).toBeVisible();
    await authedPage.getByRole('link', { name: 'Ver cuentas archivadas' }).click();
    await authedPage.getByRole('link', { name: 'Banco viejo' }).click();
    await expect(authedPage.getByText('Archivada', { exact: true })).toBeVisible();
    await expect(authedPage.getByText('Comida').first()).toBeVisible();

    // Out of the selectors of Registrar: the second account of a movement and of a transfer.
    await authedPage.goto('/registrar');
    await authedPage.getByRole('button', { name: 'Más opciones' }).click();
    await expect(authedPage.getByLabel('Otra cuenta').locator('option')).toHaveCount(1);
    await expect(authedPage.getByLabel('Otra cuenta')).toContainText('Efectivo');
    await expect(authedPage.getByLabel('Otra cuenta')).not.toContainText('Banco viejo');

    // The expense of the archived account still counts in the month.
    expect((await kindTotals(authedPage)).expense).toBe('1.00');
  });

  test('RF-M4-11 las cuentas se agrupan por tipo y se reordenan con "Bajar" respetando ese orden', async ({
    authedPage,
  }) => {
    const first = await createAccount(authedPage, { name: 'Primera' });
    const second = await createAccount(authedPage, { name: 'Segunda' });
    await createAccount(authedPage, { name: 'Banco', type: 'bank' });

    await authedPage.goto('/cuentas');
    // One group per type, each with its heading.
    await expect(authedPage.getByRole('heading', { name: 'Efectivo', exact: true })).toBeVisible();
    await expect(authedPage.getByRole('heading', { name: 'Banco', exact: true })).toBeVisible();
    expect(await listedNames(authedPage)).toEqual(['Primera', 'Segunda', 'Banco']);

    await authedPage.getByRole('button', { name: 'Bajar Primera' }).click();
    await expect.poll(async () => listedNames(authedPage)).toEqual(['Segunda', 'Primera', 'Banco']);
    await expect
      .poll(async () => (await accountsOf(authedPage)).map((item) => item.id).slice(0, 2))
      .toEqual([second, first]);

    // The order is kept after reloading.
    await authedPage.reload();
    await expect.poll(async () => listedNames(authedPage)).toEqual(['Segunda', 'Primera', 'Banco']);
  });

  test('EC-M4-04 al restaurar una cuenta cuyo nombre está en uso se pide un nombre nuevo antes de restaurarla', async ({
    authedPage,
  }) => {
    const old = await createAccount(authedPage, { name: 'Caja' });
    await archiveAccount(authedPage, old);
    await createAccount(authedPage, { name: 'Caja' });

    await authedPage.goto(`/cuentas/${old}`);
    await authedPage.getByRole('button', { name: 'Restaurar', exact: true }).click();
    const dialog = authedPage.getByRole('alertdialog');
    await expect(dialog.getByText('Elige otro nombre')).toBeVisible();
    expect((await accountsOf(authedPage, 'archived')).map((item) => item.id)).toEqual([old]);

    await dialog.getByLabel('Nombre').fill('Caja vieja');
    await dialog.getByRole('button', { name: 'Restaurar', exact: true }).click();
    await expect(dialog).toBeHidden();

    const active = await accountsOf(authedPage);
    expect(active.map((item) => item.name).sort()).toEqual(['Caja', 'Caja vieja']);
    expect(await accountsOf(authedPage, 'archived')).toEqual([]);
  });

  test('EC-M4-05 al archivar la única cuenta activa, Registrar y el Inicio invitan a crear una cuenta', async ({
    authedPage,
  }) => {
    const only = await createAccount(authedPage, { name: 'Única', initialBalance: '0' });

    await authedPage.goto(`/cuentas/${only}`);
    await authedPage.getByRole('button', { name: 'Archivar', exact: true }).click();
    await expect(authedPage.getByText('Archivada', { exact: true })).toBeVisible();
    expect(await accountsOf(authedPage)).toEqual([]);

    await authedPage.goto('/registrar');
    await expect(authedPage.getByRole('heading', { name: 'Crea tu primera cuenta' })).toBeVisible();
    await authedPage.goto('/');
    await expect(authedPage.getByRole('heading', { name: 'Crea tu primera cuenta' })).toBeVisible();
    await authedPage.goto('/cuentas');
    await expect(authedPage.getByText(/Todavía no tienes cuentas activas/)).toBeVisible();
  });

  test('EC-M4-07 al restaurar una cuenta cuya moneda está inactiva la app no la restaura hasta reactivar la moneda', async ({
    authedPage,
  }) => {
    const currency = await authedPage.request.post('/api/currencies', {
      data: { code: 'EUR', symbol: '€', rate: '7.50' },
    });
    expect(currency.status()).toBe(201);
    const euro = await createAccount(authedPage, {
      name: 'Euros',
      type: 'bank',
      currencyCode: 'EUR',
      initialBalance: '10',
    });
    await archiveAccount(authedPage, euro);
    const off = await authedPage.request.post('/api/currencies/EUR/deactivate');
    expect(off.ok()).toBe(true);

    await authedPage.goto(`/cuentas/${euro}`);
    await authedPage.getByRole('button', { name: 'Restaurar', exact: true }).click();
    await expect(authedPage.getByRole('alert').filter({ hasText: /moneda/i })).toBeVisible();
    expect((await accountsOf(authedPage, 'archived')).map((item) => item.id)).toEqual([euro]);

    const on = await authedPage.request.post('/api/currencies/EUR/activate', {
      data: { rate: '7.50' },
    });
    expect(on.ok()).toBe(true);
    await authedPage.reload();
    await authedPage.getByRole('button', { name: 'Restaurar', exact: true }).click();
    await expect(authedPage.getByRole('button', { name: 'Archivar', exact: true })).toBeVisible();
    expect((await accountsOf(authedPage)).map((item) => item.id)).toEqual([euro]);
  });
});

test.describe('TASK-243 M5 categorías', () => {
  test('RF-M5-08 Fusionar duplicados: "Taxi/Apps" queda con 52 movimientos y "Taxis" deja de existir', async ({
    authedPage,
  }) => {
    const bank = await createAccount(authedPage, {
      name: 'Banco',
      type: 'bank',
      initialBalance: '0',
    });
    const target = await expenseCategory(authedPage, 'Taxi/Apps');
    const taxisId = randomUUID();
    const created = await authedPage.request.post('/api/categories', {
      data: { id: taxisId, kind: 'expense', parentId: null, name: 'Taxis', icon: 'car' },
    });
    expect(created.status()).toBe(201);
    await createExpenses(authedPage, bank, taxisId, 12);
    await createExpenses(authedPage, bank, target.id, 40);
    expect(await countIn(authedPage, taxisId)).toBe(12);
    expect(await countIn(authedPage, target.id)).toBe(40);

    await authedPage.goto('/categorias');
    const source = authedPage.getByLabel('Fusionar una categoría con otra');
    await source.selectOption({ label: 'Taxis' });
    const dialog = authedPage.getByRole('dialog', { name: 'Fusionar Taxis' });
    await dialog.getByLabel('Categoría destino').selectOption({ label: 'Taxi/Apps' });
    await expect(dialog.getByText('Se moverán 12 movimientos.')).toBeVisible();
    await dialog.getByRole('button', { name: 'Fusionar', exact: true }).click();
    await expect(dialog).toBeHidden();

    expect(await countIn(authedPage, target.id)).toBe(52);
    const names = (await categoryTree(authedPage)).flatMap((root) => [root, ...root.children]);
    expect(names.map((node) => node.name)).not.toContain('Taxis');
    await expect(source.locator('option', { hasText: 'Taxis' })).toHaveCount(0);
    await expect(
      authedPage.getByLabel('Editar una categoría').locator('option', { hasText: 'Taxis' }),
    ).toHaveCount(0);
  });

  test('EC-M5-02 una categoría con subcategorías no se ofrece para fusionar hasta fusionar o mover las hijas', async ({
    authedPage,
  }) => {
    const transport = await expenseCategory(authedPage, 'Transporte');
    expect(transport.children.length).toBeGreaterThan(0);

    await authedPage.goto('/categorias');
    const source = authedPage.getByLabel('Fusionar una categoría con otra');
    await expect(source).toBeVisible();
    const offered = await source.locator('option').allTextContents();
    expect(offered).not.toContain('Transporte');
    expect(offered).not.toContain('Comida');
    // The subcategories and the categories without children are mergeable.
    expect(offered).toContain('Taxi/Apps');
    expect(offered).toContain('Salud');

    // The API refuses it too, with nothing moved.
    const target = await expenseCategory(authedPage, 'Ocio');
    const merge = await authedPage.request.post('/api/categories/merge', {
      data: { fromId: transport.id, toId: target.id },
    });
    expect(merge.status()).toBe(422);
    expect(((await merge.json()) as { code: string }).code).toBe('MERGE_INVALID');
    expect((await expenseCategory(authedPage, 'Transporte')).children).toHaveLength(
      transport.children.length,
    );
  });

  test('RF-M5-05 Categoría del sistema protegida: "Deudas y préstamos" no ofrece archivar', async ({
    authedPage,
  }) => {
    const system = (await categoryTree(authedPage)).find((node) => node.isSystem);
    expect(system?.name).toBe('Deudas y préstamos');

    await authedPage.goto('/categorias');
    const row = authedPage.getByTestId(`category-${system?.id ?? ''}`);
    await expect(row).toBeVisible();
    await expect(row.getByText('Del sistema')).toBeVisible();
    await expect(row.getByRole('button', { name: 'Archivar', exact: true })).toHaveCount(0);

    // A normal category does offer it, so the missing action is the protection.
    const health = await expenseCategory(authedPage, 'Salud');
    const normal = authedPage.getByTestId(`category-${health.id}`);
    await expect(normal.getByRole('button', { name: 'Archivar', exact: true })).toBeVisible();

    // The system category is not offered to edit or merge either.
    await expect(
      authedPage
        .getByLabel('Editar una categoría')
        .locator('option', { hasText: 'Deudas y préstamos' }),
    ).toHaveCount(0);
    await expect(
      authedPage
        .getByLabel('Fusionar una categoría con otra')
        .locator('option', { hasText: 'Deudas y préstamos' }),
    ).toHaveCount(0);
  });
});
