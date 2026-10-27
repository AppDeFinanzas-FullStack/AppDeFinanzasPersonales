import { randomUUID } from 'node:crypto';

import type { Locator, Page } from '@playwright/test';

import { expect, test } from './fixtures/auth.js';

/**
 * TASK-169: the flows of Registrar and Movimientos are done with the keyboard alone (RF-M7-12,
 * RNF-06), and every action by gesture has its alternative: the checkboxes of the batch, and the
 * "Subir" and "Bajar" buttons to reorder. They run in the 6 projects of the matrix: Chromium,
 * WebKit and Firefox at 360 px and at 1280 px (RNF-05).
 */

const BOLIVIA_OFFSET_MS = 4 * 60 * 60 * 1000;
/** From this width the rows of Movimientos show their checkbox (the `lg` breakpoint). */
const CHECKBOX_MIN_WIDTH = 1024;
const MAX_TABS = 80;

interface CategoryNode {
  id: string;
  name: string;
  kind: string;
  status: string;
  children: CategoryNode[];
}

interface RegisterContext {
  grid: { expense: { id: string; name: string }[]; income: { id: string; name: string }[] };
}

interface TransactionList {
  items: {
    id: string;
    date: string;
    note: string | null;
    entries: { amount: string }[];
  }[];
}

const pad = (n: number): string => String(n).padStart(2, '0');

function bolivianDate(offsetDays = 0): string {
  const now = new Date(Date.now() - BOLIVIA_OFFSET_MS - offsetDays * 86_400_000);
  return `${now.getUTCFullYear()}-${pad(now.getUTCMonth() + 1)}-${pad(now.getUTCDate())}`;
}

function twoMonthsAgoStart(): string {
  const now = new Date(Date.now() - BOLIVIA_OFFSET_MS);
  const index = now.getUTCFullYear() * 12 + now.getUTCMonth() - 2;
  return `${Math.floor(index / 12)}-${pad((index % 12) + 1)}-01`;
}

async function createAccount(page: Page, name: string): Promise<string> {
  const id = randomUUID();
  const res = await page.request.post('/api/accounts', {
    data: {
      id,
      type: 'cash',
      name,
      currencyCode: 'BOB',
      initialBalance: '1000',
      initialBalanceDate: twoMonthsAgoStart(),
      color: 'teal',
      icon: 'wallet',
    },
  });
  expect(res.status(), `POST /api/accounts ${name}`).toBe(201);
  return id;
}

async function rootCategories(page: Page, kind: 'expense' | 'income'): Promise<CategoryNode[]> {
  const res = await page.request.get(`/api/categories?kind=${kind}&status=active`);
  expect(res.ok()).toBe(true);
  return (await res.json()) as CategoryNode[];
}

async function registerContext(page: Page): Promise<RegisterContext> {
  const res = await page.request.get('/api/register/context');
  expect(res.ok()).toBe(true);
  return (await res.json()) as RegisterContext;
}

async function listTransactions(page: Page): Promise<TransactionList['items']> {
  const res = await page.request.get('/api/transactions');
  expect(res.ok()).toBe(true);
  return ((await res.json()) as TransactionList).items;
}

async function recordExpense(
  page: Page,
  accountId: string,
  categoryId: string,
  amount: string,
  note: string,
): Promise<void> {
  const res = await page.request.post('/api/transactions', {
    data: {
      kind: 'expense',
      id: randomUUID(),
      accountId,
      categoryId,
      amount,
      date: bolivianDate(),
      note,
    },
  });
  expect(res.status(), `POST /api/transactions ${note}`).toBe(201);
}

/** Whether the element is the one with the keyboard focus. */
async function hasFocus(target: Locator): Promise<boolean> {
  return target
    .evaluate((element) => element === element.ownerDocument.activeElement, undefined, {
      timeout: 2_000,
    })
    .catch(() => false);
}

/**
 * Moves the focus with the keyboard alone (Tab, or Shift+Tab) until `target` has it, the way a
 * person who cannot use a pointer would. It fails if the element cannot be reached.
 */
async function tabTo(page: Page, target: Locator, key: 'Tab' | 'Shift+Tab' = 'Tab'): Promise<void> {
  await expect(target).toHaveCount(1);
  for (let presses = 0; presses <= MAX_TABS; presses += 1) {
    if (await hasFocus(target)) return;
    await page.keyboard.press(key);
  }
  throw new Error(`The element cannot be reached with ${key} in ${String(MAX_TABS)} presses`);
}

/** Focuses `target` with the keyboard and activates it with Enter. */
async function pressWithEnter(page: Page, target: Locator): Promise<void> {
  await tabTo(page, target);
  await page.keyboard.press('Enter');
}

function amountField(page: Page): Locator {
  return page.getByLabel('Monto', { exact: true });
}

function categoryChip(page: Page, name: string): Locator {
  return page
    .getByRole('group', { name: 'Categoría', exact: true })
    .getByRole('button', { name, exact: true });
}

function saveButton(page: Page): Locator {
  return page.getByRole('button', { name: 'Guardar', exact: true });
}

test.describe('TASK-169 Registrar solo con el teclado', () => {
  test('RF-M7-12 se registra un gasto solo con el teclado: Tab, Enter y el teclado numérico', async ({
    authedPage,
  }) => {
    await createAccount(authedPage, 'Efectivo');
    const category = (await registerContext(authedPage)).grid.expense[0]?.name ?? '';
    expect(category).not.toBe('');

    await authedPage.goto('/registrar');
    // The focus starts on the amount: typing needs no pointer.
    await expect(amountField(authedPage)).toBeFocused();
    await authedPage.keyboard.type('35');
    await expect(amountField(authedPage)).toHaveValue('35');
    await expect(saveButton(authedPage)).toBeDisabled();

    await pressWithEnter(authedPage, categoryChip(authedPage, category));
    await expect(categoryChip(authedPage, category)).toHaveAttribute('aria-pressed', 'true');
    await expect(saveButton(authedPage)).toBeEnabled();

    await pressWithEnter(authedPage, saveButton(authedPage));
    await expect(authedPage.getByText(/Gasto de .*35,00.* guardado/).first()).toBeVisible();

    const saved = await listTransactions(authedPage);
    expect(saved).toHaveLength(1);
    expect(saved[0]?.entries.map((entry) => entry.amount)).toContain('-35.00');
    // The form is ready for the next movement, with the focus back on the amount.
    await expect(amountField(authedPage)).toBeFocused();
    await expect(amountField(authedPage)).toHaveValue('');
  });

  test('RF-M7-12 un ingreso se elige con Tab y Enter y se guarda con Enter en el monto', async ({
    authedPage,
  }) => {
    await createAccount(authedPage, 'Efectivo');
    const category = (await registerContext(authedPage)).grid.income[0]?.name ?? '';
    expect(category).not.toBe('');

    await authedPage.goto('/registrar');
    await expect(amountField(authedPage)).toBeFocused();

    // Back with Shift+Tab to the kind of movement, and Enter chooses "Ingreso".
    const income = authedPage.getByRole('button', { name: 'Ingreso', exact: true });
    await tabTo(authedPage, income, 'Shift+Tab');
    await authedPage.keyboard.press('Enter');
    await expect(income).toHaveAttribute('aria-pressed', 'true');

    await tabTo(authedPage, amountField(authedPage));
    await authedPage.keyboard.type('120,50');
    await pressWithEnter(authedPage, categoryChip(authedPage, category));
    await expect(categoryChip(authedPage, category)).toHaveAttribute('aria-pressed', 'true');

    // Enter inside the amount saves when the form is ready.
    await tabTo(authedPage, amountField(authedPage), 'Shift+Tab');
    await authedPage.keyboard.press('Enter');
    await expect(authedPage.getByText(/Ingreso de .*120,50.* guardado/).first()).toBeVisible();

    const saved = await listTransactions(authedPage);
    expect(saved).toHaveLength(1);
    expect(saved[0]?.entries.map((entry) => entry.amount)).toContain('120.50');
  });

  test('RF-M7-12 el formulario completo con el teclado: otra categoría de "Ver todas", fecha "Ayer" y nota', async ({
    authedPage,
  }) => {
    await createAccount(authedPage, 'Efectivo');
    const category = (await registerContext(authedPage)).grid.expense[0]?.name ?? '';
    expect(category).not.toBe('');

    await authedPage.goto('/registrar');
    await expect(amountField(authedPage)).toBeFocused();
    await authedPage.keyboard.type('48');

    // "Ver todas" opens the list; the focus goes inside it and Enter picks the category.
    await pressWithEnter(authedPage, authedPage.getByRole('button', { name: 'Ver todas' }));
    const sheet = authedPage.getByRole('dialog');
    await expect(sheet).toBeVisible();
    await pressWithEnter(authedPage, sheet.getByRole('button', { name: category, exact: true }));
    await expect(sheet).toHaveCount(0);
    await expect(categoryChip(authedPage, category)).toHaveAttribute('aria-pressed', 'true');

    await pressWithEnter(authedPage, authedPage.getByRole('button', { name: 'Ayer', exact: true }));
    await expect(authedPage.getByRole('button', { name: 'Ayer', exact: true })).toHaveAttribute(
      'aria-pressed',
      'true',
    );

    await pressWithEnter(authedPage, authedPage.getByRole('button', { name: /más opciones/i }));
    const note = authedPage.getByLabel('Nota', { exact: true });
    await tabTo(authedPage, note);
    await authedPage.keyboard.type('Cena con amigos');

    await pressWithEnter(authedPage, saveButton(authedPage));
    await expect(authedPage.getByText(/Gasto de .*48,00.* guardado/).first()).toBeVisible();

    const saved = await listTransactions(authedPage);
    expect(saved).toHaveLength(1);
    expect(saved[0]?.note).toBe('Cena con amigos');
    expect(saved[0]?.date).toBe(bolivianDate(1));
    expect(saved[0]?.entries.map((entry) => entry.amount)).toContain('-48.00');
  });

  test('RF-M7-12 una transferencia entre dos cuentas se registra solo con el teclado', async ({
    authedPage,
  }) => {
    await createAccount(authedPage, 'Efectivo');
    await createAccount(authedPage, 'Ahorros');

    await authedPage.goto('/registrar');
    await expect(amountField(authedPage)).toBeFocused();

    const transfer = authedPage.getByRole('button', { name: 'Transferencia', exact: true });
    await tabTo(authedPage, transfer, 'Shift+Tab');
    await authedPage.keyboard.press('Enter');
    await expect(transfer).toHaveAttribute('aria-pressed', 'true');

    await tabTo(authedPage, amountField(authedPage));
    await authedPage.keyboard.type('50');
    await expect(saveButton(authedPage)).toBeEnabled();
    await pressWithEnter(authedPage, saveButton(authedPage));
    await expect(authedPage.getByText(/Transferencia de .*50,00.* guardada/).first()).toBeVisible();

    const saved = await listTransactions(authedPage);
    expect(saved).toHaveLength(1);
    expect(saved[0]?.entries.map((entry) => entry.amount).sort()).toEqual(['-50.00', '50.00']);
  });
});

test.describe('TASK-169 Movimientos solo con el teclado', () => {
  async function seedMovements(page: Page): Promise<{ names: string[] }> {
    const accountId = await createAccount(page, 'Efectivo');
    const roots = await rootCategories(page, 'expense');
    const picked = roots.slice(0, 3);
    expect(picked).toHaveLength(3);
    const notes = ['Taxi', 'Almuerzo', 'Cine'];
    for (const [index, category] of picked.entries()) {
      await recordExpense(page, accountId, category.id, String(10 + index), notes[index] ?? '');
    }
    return { names: picked.map((category) => category.name) };
  }

  function row(page: Page, note: string): Locator {
    return page.getByRole('main').getByRole('link', { name: new RegExp(note) });
  }

  function batchRegion(page: Page): Locator {
    return page.getByRole('region', { name: /acciones con los movimientos seleccionados/i });
  }

  test('RNF-06 los movimientos se seleccionan con la barra espaciadora y el lote se elimina y se deshace con el teclado', async ({
    authedPage,
  }) => {
    await seedMovements(authedPage);
    await authedPage.goto('/movimientos');
    await expect(row(authedPage, 'Taxi')).toBeVisible();

    // The Space key on a row is the alternative to the long press (and to the checkbox).
    await tabTo(authedPage, row(authedPage, 'Taxi'));
    await authedPage.keyboard.press('Space');
    await expect(batchRegion(authedPage).getByText(/1 movimiento seleccionado/)).toBeVisible();

    await tabTo(authedPage, row(authedPage, 'Cine'));
    await authedPage.keyboard.press('Space');
    await expect(batchRegion(authedPage).getByText(/2 movimientos seleccionados/)).toBeVisible();

    await pressWithEnter(
      authedPage,
      batchRegion(authedPage).getByRole('button', { name: 'Eliminar', exact: true }),
    );
    await expect(batchRegion(authedPage).getByText(/Se procesaron 2 movimientos/)).toBeVisible();
    await expect(row(authedPage, 'Taxi')).toHaveCount(0);
    await expect(row(authedPage, 'Cine')).toHaveCount(0);
    await expect(row(authedPage, 'Almuerzo')).toBeVisible();

    await pressWithEnter(
      authedPage,
      batchRegion(authedPage).getByRole('button', { name: 'Deshacer', exact: true }),
    );
    await expect(row(authedPage, 'Taxi')).toBeVisible();
    await expect(row(authedPage, 'Cine')).toBeVisible();
    expect(await listTransactions(authedPage)).toHaveLength(3);
  });

  test('RNF-06 las casillas del lote se marcan con el teclado y "Cambiar categoría" se aplica al lote', async ({
    authedPage,
    projectWidth,
  }) => {
    const { names } = await seedMovements(authedPage);
    const target = (await rootCategories(authedPage, 'expense'))[3]?.name ?? '';
    expect(target).not.toBe('');
    await authedPage.goto('/movimientos');
    await expect(row(authedPage, 'Taxi')).toBeVisible();

    if (projectWidth >= CHECKBOX_MIN_WIDTH) {
      // With a wide screen every row has its checkbox, reached with Tab and marked with Space.
      for (const name of [names[0] ?? '', names[1] ?? '']) {
        const box = authedPage.getByRole('checkbox', { name: `Seleccionar ${name}`, exact: true });
        await tabTo(authedPage, box);
        await authedPage.keyboard.press('Space');
        await expect(box).toBeChecked();
      }
    } else {
      // On a phone the Space key on the row replaces both the checkbox and the long press.
      for (const note of ['Taxi', 'Almuerzo']) {
        await tabTo(authedPage, row(authedPage, note));
        await authedPage.keyboard.press('Space');
      }
    }
    await expect(batchRegion(authedPage).getByText(/2 movimientos seleccionados/)).toBeVisible();

    const select = batchRegion(authedPage).getByLabel('Elige una categoría');
    await tabTo(authedPage, select);
    await authedPage.keyboard.type(target.slice(0, 3));
    await expect(select.locator('option:checked')).toHaveText(target);
    await pressWithEnter(
      authedPage,
      batchRegion(authedPage).getByRole('button', { name: 'Cambiar categoría' }),
    );
    await expect(batchRegion(authedPage).getByText(/Se procesaron 2 movimientos/)).toBeVisible();
  });

  test('RNF-06 una fila se abre con Enter y su detalle se edita con el teclado', async ({
    authedPage,
  }) => {
    await seedMovements(authedPage);
    await authedPage.goto('/movimientos');
    await expect(row(authedPage, 'Taxi')).toBeVisible();

    await pressWithEnter(authedPage, row(authedPage, 'Taxi'));
    await expect(authedPage).toHaveURL(/\/movimientos\/[0-9a-f-]+$/);

    await pressWithEnter(
      authedPage,
      authedPage.getByRole('button', { name: 'Editar', exact: true }),
    );
    const note = authedPage.getByLabel('Nota', { exact: true });
    await tabTo(authedPage, note);
    await authedPage.keyboard.press('ControlOrMeta+A');
    await authedPage.keyboard.type('Taxi al aeropuerto');
    await pressWithEnter(
      authedPage,
      authedPage.getByRole('button', { name: 'Guardar cambios', exact: true }),
    );

    await expect
      .poll(async () => (await listTransactions(authedPage)).map((item) => item.note))
      .toContain('Taxi al aeropuerto');
  });
});

test.describe('TASK-169 alternativas a los gestos: "Subir" y "Bajar"', () => {
  test('RNF-06 las cuentas se reordenan con "Subir" y "Bajar" con el teclado', async ({
    authedPage,
  }) => {
    await createAccount(authedPage, 'Efectivo');
    await createAccount(authedPage, 'Ahorros');
    const names = async (): Promise<string[]> => {
      const res = await authedPage.request.get('/api/accounts?status=active');
      expect(res.ok()).toBe(true);
      return ((await res.json()) as { items: { name: string }[] }).items.map((item) => item.name);
    };
    expect(await names()).toEqual(['Efectivo', 'Ahorros']);

    await authedPage.goto('/cuentas');
    await expect(authedPage.getByRole('link', { name: 'Ahorros' })).toBeVisible();
    await pressWithEnter(authedPage, authedPage.getByRole('button', { name: 'Subir Ahorros' }));
    await expect.poll(names).toEqual(['Ahorros', 'Efectivo']);

    await expect(authedPage.getByRole('button', { name: 'Subir Ahorros' })).toBeDisabled();
    await pressWithEnter(authedPage, authedPage.getByRole('button', { name: 'Bajar Ahorros' }));
    await expect.poll(names).toEqual(['Efectivo', 'Ahorros']);
  });

  test('RNF-06 las categorías se reordenan con "Subir" y "Bajar" con el teclado', async ({
    authedPage,
  }) => {
    const order = async (): Promise<string[]> =>
      (await rootCategories(authedPage, 'expense')).map((category) => category.name);
    const before = await order();
    const [first, second] = before;
    expect(first).toBeDefined();
    expect(second).toBeDefined();

    await authedPage.goto('/categorias');
    await expect(authedPage.getByRole('button', { name: `Bajar ${first ?? ''}` })).toBeVisible();
    await pressWithEnter(
      authedPage,
      authedPage.getByRole('button', { name: `Bajar ${first ?? ''}` }),
    );
    await expect.poll(async () => (await order()).slice(0, 2)).toEqual([second, first]);

    await pressWithEnter(
      authedPage,
      authedPage.getByRole('button', { name: `Subir ${first ?? ''}` }),
    );
    await expect.poll(async () => (await order()).slice(0, 2)).toEqual([first, second]);
  });

  test('RNF-06 los atajos se reordenan con "Subir" y "Bajar" con el teclado', async ({
    authedPage,
  }) => {
    const accountId = await createAccount(authedPage, 'Efectivo');
    const categoryId = (await rootCategories(authedPage, 'expense'))[0]?.id ?? '';
    for (const name of ['Almuerzo', 'Pasaje']) {
      const res = await authedPage.request.post('/api/shortcuts', {
        data: { id: randomUUID(), name, kind: 'expense', accountId, categoryId },
      });
      expect(res.status()).toBe(201);
    }
    const names = async (): Promise<string[]> => {
      const res = await authedPage.request.get('/api/shortcuts');
      expect(res.ok()).toBe(true);
      return ((await res.json()) as { items: { name: string }[] }).items.map((item) => item.name);
    };
    expect(await names()).toEqual(['Almuerzo', 'Pasaje']);

    await authedPage.goto('/ajustes/registrar');
    await expect(authedPage.getByRole('button', { name: 'Subir Pasaje' })).toBeVisible();
    await pressWithEnter(authedPage, authedPage.getByRole('button', { name: 'Subir Pasaje' }));
    await expect.poll(names).toEqual(['Pasaje', 'Almuerzo']);
  });

  test('RNF-06 los bloques del Inicio se reordenan con "Subir" y "Bajar" con el teclado', async ({
    authedPage,
  }) => {
    const order = async (): Promise<string[]> => {
      const res = await authedPage.request.get('/api/settings');
      expect(res.ok()).toBe(true);
      const blocks = ((await res.json()) as { dashboardBlocks: { key: string }[] }).dashboardBlocks;
      return blocks.map((block) => block.key).filter((key) => ['byCategory', 'pace'].includes(key));
    };
    expect(await order()).toEqual(['byCategory', 'pace']);

    await authedPage.goto('/ajustes/inicio');
    await expect(authedPage.getByRole('button', { name: /Subir Ritmo del gasto/ })).toBeVisible();
    await pressWithEnter(
      authedPage,
      authedPage.getByRole('button', { name: /Subir Ritmo del gasto/ }),
    );
    await expect.poll(order).toEqual(['pace', 'byCategory']);

    await pressWithEnter(
      authedPage,
      authedPage.getByRole('button', { name: /Bajar Ritmo del gasto/ }),
    );
    await expect.poll(order).toEqual(['byCategory', 'pace']);
  });
});
