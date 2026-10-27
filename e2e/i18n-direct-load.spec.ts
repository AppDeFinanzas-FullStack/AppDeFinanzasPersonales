import { randomUUID } from 'node:crypto';

import type { Locator, Page } from '@playwright/test';

import { expect, test } from './fixtures/auth.js';

/**
 * TASK-249: the text `goals` is registered only when `features/goals/routes.tsx` or
 * `features/debts/routes.tsx` load. A person who enters straight to Registrar, to Cuentas or to the
 * detail of an account, without going through Metas first, must not see i18n keys (RNF-07).
 * Every case below starts from a full page load (`page.goto`), so no module of another feature has
 * registered its text before.
 */

interface CategoryNode {
  id: string;
  kind: string;
  status: string;
  name: string;
  children: CategoryNode[];
}

interface World {
  bankId: string;
  cashId: string;
  goalId: string;
  budgetId: string;
  debtId: string;
  transactionId: string;
  categoryId: string;
  categoryName: string;
}

function dayFromToday(offsetDays: number): string {
  const at = new Date(Date.now() + offsetDays * 86_400_000);
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/La_Paz',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(at);
}

function flatten(nodes: CategoryNode[]): CategoryNode[] {
  return nodes.flatMap((n) => [n, ...flatten(n.children)]);
}

async function createAccount(
  page: Page,
  name: string,
  initialBalance: string,
  type: 'cash' | 'bank' | 'savings' = 'cash',
): Promise<string> {
  const id = randomUUID();
  const res = await page.request.post('/api/accounts', {
    data: {
      id,
      type,
      name,
      currencyCode: 'BOB',
      initialBalance,
      initialBalanceDate: dayFromToday(-30),
      color: 'teal',
      icon: 'wallet',
    },
  });
  expect(res.status(), `POST /api/accounts ${name}`).toBe(201);
  return id;
}

async function createGoal(page: Page, name: string, target: string): Promise<string> {
  const id = randomUUID();
  const res = await page.request.post('/api/goals', {
    data: { id, name, target, currencyCode: 'BOB', icon: 'plane', color: 'blue' },
  });
  expect(res.status(), `POST /api/goals ${name}`).toBe(201);
  return id;
}

async function earmark(
  page: Page,
  goalId: string,
  accountId: string,
  amount: string,
): Promise<void> {
  const res = await page.request.post(`/api/goals/${goalId}/earmarks`, {
    data: { id: randomUUID(), accountId, amount },
  });
  expect(res.ok(), 'POST /api/goals/:id/earmarks').toBe(true);
}

async function progressOf(page: Page, goalId: string): Promise<number> {
  const res = await page.request.get(`/api/goals/${goalId}`);
  expect(res.ok()).toBe(true);
  return Number(((await res.json()) as { progress: string }).progress);
}

async function expenseCategory(page: Page): Promise<CategoryNode> {
  const res = await page.request.get('/api/categories?kind=expense&status=active');
  expect(res.ok()).toBe(true);
  const found = flatten((await res.json()) as CategoryNode[]).find(
    (n) => n.kind === 'expense' && n.status === 'active',
  );
  expect(found).toBeDefined();
  return found as CategoryNode;
}

async function incomeCategoryId(page: Page): Promise<string> {
  const res = await page.request.get('/api/categories?kind=income&status=active');
  expect(res.ok()).toBe(true);
  const found = flatten((await res.json()) as CategoryNode[]).find(
    (n) => n.kind === 'income' && n.status === 'active',
  );
  expect(found).toBeDefined();
  return found?.id ?? '';
}

async function createTransaction(
  page: Page,
  kind: 'expense' | 'income',
  accountId: string,
  categoryId: string,
  amount: string,
): Promise<string> {
  const id = randomUUID();
  const res = await page.request.post('/api/transactions', {
    data: { kind, id, accountId, categoryId, amount, date: dayFromToday(0) },
  });
  expect(res.status(), 'POST /api/transactions').toBe(201);
  return id;
}

/** A new user with an account, a goal with an earmark, a budget and a debt (TASK-249). */
async function seedWorld(page: Page): Promise<World> {
  const bankId = await createAccount(page, 'Banco', '4800.00', 'bank');
  const cashId = await createAccount(page, 'Efectivo', '500.00', 'cash');
  const goalId = await createGoal(page, 'Viaje', '3000.00');
  await earmark(page, goalId, bankId, '300.00');
  const category = await expenseCategory(page);

  const budgetId = randomUUID();
  const budget = await page.request.post('/api/budgets', {
    data: { id: budgetId, scope: 'general', amount: '1000.00', currencyCode: 'BOB' },
  });
  expect(budget.status(), 'POST /api/budgets').toBe(201);

  const debtId = randomUUID();
  const debt = await page.request.post('/api/debts', {
    data: {
      id: debtId,
      direction: 'i_owe',
      person: 'Carla',
      principal: '300.00',
      currencyCode: 'BOB',
      startDate: dayFromToday(-10),
      dueDate: dayFromToday(3),
    },
  });
  expect(debt.status(), 'POST /api/debts').toBe(201);

  const transactionId = await createTransaction(page, 'expense', cashId, category.id, '20');
  return {
    bankId,
    cashId,
    goalId,
    budgetId,
    debtId,
    transactionId,
    categoryId: category.id,
    categoryName: category.name,
  };
}

/**
 * An i18n key that came out untranslated: dotted segments with no spaces (`summary.earmarked`,
 * `confirm.title`), or the same with a namespace (`goals:summary.earmarked`). A single word such
 * as `cancel` is not distinguishable from Spanish text, so only dotted keys are searched; the
 * texts of the product have no word of this shape.
 */
const I18N_KEY = /^(?:[a-z][A-Za-z0-9]*:)?[a-z][A-Za-z0-9_]*(?:\.[A-Za-z][A-Za-z0-9_]*)+$/;

/** The words of `text` that look like an i18n key. */
function untranslatedKeys(text: string): string[] {
  const words = text
    .split(/[\s,;()[\]"'«»“”]+/)
    .map((word) => word.replace(/[.:!?]+$/, ''))
    .filter((word) => word.length > 0);
  return [...new Set(words.filter((word) => I18N_KEY.test(word)))];
}

/** Everything a person reads or hears on the page: visible text, `aria-label`, `title`, `placeholder`. */
async function readableStrings(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const out: string[] = [document.body.innerText];
    for (const element of document.querySelectorAll('[aria-label], [title], [placeholder]')) {
      for (const name of ['aria-label', 'title', 'placeholder']) {
        const value = element.getAttribute(name);
        if (value !== null && value !== '') out.push(value);
      }
    }
    return out;
  });
}

async function expectNoUntranslatedKeys(page: Page, where: string): Promise<void> {
  const found = (await readableStrings(page)).flatMap((text) => untranslatedKeys(text));
  expect(found, `claves de i18n sin traducir en ${where}`).toEqual([]);
}

/** Waits until the screen has its content: the route loaded and no skeleton left. */
async function settle(page: Page): Promise<void> {
  await expect(page.getByRole('main')).toBeVisible();
  await expect(page.locator('.animate-pulse')).toHaveCount(0);
  await page.waitForLoadState('networkidle');
  await page.evaluate(() => document.fonts.ready);
}

/** A direct load: the page is fetched from the server, with nothing registered beforehand. */
async function load(page: Page, path: string): Promise<void> {
  await page.goto(path);
  await settle(page);
}

/** The value (`dd`) that goes with the label (`dt`) `label` in a definition list. */
function valueOf(page: Page, label: string): Locator {
  return page.getByText(label, { exact: true }).locator('xpath=following-sibling::dd');
}

function earmarkDialog(page: Page): Locator {
  return page.getByRole('dialog').filter({ hasText: /usa .*apartad/i });
}

/** The confirmation of earmarks has its title, its description and its two buttons translated. */
async function expectConfirmTranslated(page: Page): Promise<void> {
  const dialog = earmarkDialog(page);
  await expect(dialog).toBeVisible();
  await expect(dialog.getByText(/^Este gasto usa .* apartados$/)).toBeVisible();
  await expect(
    dialog.getByText('Elige de qué metas tomar ese dinero. Puedes cambiar la propuesta.'),
  ).toBeVisible();
  await expect(dialog.getByRole('button', { name: 'Confirmar', exact: true })).toBeVisible();
  await expect(dialog.getByRole('button', { name: 'Cancelar', exact: true })).toBeVisible();
  await expectNoUntranslatedKeys(page, 'la confirmación de apartados');
}

test.describe('TASK-249 el detector de claves sin traducir', () => {
  test('RNF-07 reconoce las claves de i18n y deja pasar el texto en español', () => {
    expect(untranslatedKeys('summary.earmarked')).toEqual(['summary.earmarked']);
    expect(untranslatedKeys('Total confirm.title y actions.cancel')).toEqual([
      'confirm.title',
      'actions.cancel',
    ]);
    expect(untranslatedKeys('goals:summary.earmarked')).toEqual(['goals:summary.earmarked']);
    expect(untranslatedKeys('Apartado para metas. Saldo 1.150,00 Bs, a@b.com')).toEqual([]);
  });
});

/** Every private route of the product up to V1.2 (the user has the Onboarding finished). */
const PRIVATE_ROUTES: readonly { name: string; path: (world: World) => string }[] = [
  { name: 'Inicio', path: () => '/' },
  { name: 'Movimientos', path: () => '/movimientos' },
  { name: 'Detalle de un movimiento', path: (w) => `/movimientos/${w.transactionId}` },
  { name: 'Registrar', path: () => '/registrar' },
  { name: 'Cuentas', path: () => '/cuentas' },
  { name: 'Nueva cuenta', path: () => '/cuentas/nueva' },
  { name: 'Detalle de una cuenta', path: (w) => `/cuentas/${w.bankId}` },
  { name: 'Detalle de una cuenta con ajuste', path: (w) => `/cuentas/${w.bankId}?ajustar=1` },
  { name: 'Editar una cuenta', path: (w) => `/cuentas/${w.bankId}/editar` },
  { name: 'Categorías', path: () => '/categorias' },
  { name: 'Nueva categoría', path: () => '/categorias/nueva' },
  { name: 'Categorías archivadas', path: () => '/categorias/archivadas' },
  { name: 'Editar una categoría', path: (w) => `/categorias/${w.categoryId}/editar` },
  { name: 'Tipo de cambio', path: () => '/tipo-de-cambio' },
  { name: 'Presupuestos', path: () => '/presupuestos' },
  { name: 'Detalle de un presupuesto', path: (w) => `/presupuestos/${w.budgetId}` },
  { name: 'Metas', path: () => '/metas' },
  { name: 'Detalle de una meta', path: (w) => `/metas/${w.goalId}` },
  { name: 'Recurrentes', path: () => '/recurrentes' },
  { name: 'Deudas y préstamos', path: () => '/deudas' },
  { name: 'Detalle de una deuda', path: (w) => `/deudas/${w.debtId}` },
  { name: 'Más', path: () => '/mas' },
  { name: 'Perfil', path: () => '/perfil' },
  { name: 'Eliminar la cuenta de usuario', path: () => '/perfil/eliminar' },
  { name: 'Ajustes', path: () => '/ajustes' },
  { name: 'Ajustes › General', path: () => '/ajustes/general' },
  { name: 'Ajustes › Monedas', path: () => '/ajustes/monedas' },
  { name: 'Ajustes › Registrar', path: () => '/ajustes/registrar' },
  { name: 'Ajustes › Inicio', path: () => '/ajustes/inicio' },
  { name: 'Ajustes › Recordatorios', path: () => '/ajustes/recordatorios' },
];

test.describe('TASK-249 carga directa de cada ruta privada', () => {
  for (const route of PRIVATE_ROUTES) {
    test(`RNF-07 ${route.name} cargada de forma directa no muestra claves de i18n`, async ({
      authedPage,
    }) => {
      const world = await seedWorld(authedPage);
      const path = route.path(world);
      await load(authedPage, path);
      await expectNoUntranslatedKeys(authedPage, path);
    });
  }

  test('RNF-07 la bandeja de avisos abierta tras una carga directa no muestra claves de i18n', async ({
    authedPage,
  }) => {
    await seedWorld(authedPage);
    await load(authedPage, '/cuentas');
    await expectNoUntranslatedKeys(authedPage, '/cuentas');
    await authedPage
      .getByRole('banner')
      .getByRole('button', { name: /avisos/i })
      .click();
    await expect(authedPage.getByRole('dialog')).toBeVisible();
    await expectNoUntranslatedKeys(authedPage, 'la bandeja de avisos');
  });
});

test.describe('TASK-249 textos de metas en Cuentas', () => {
  test('RF-M4-10 Cuentas, cargada de forma directa, muestra Apartado para metas', async ({
    authedPage,
  }) => {
    await seedWorld(authedPage);
    await load(authedPage, '/cuentas');
    await expect(authedPage.getByText('Apartado para metas', { exact: true })).toBeVisible();
    await expect(valueOf(authedPage, 'Apartado para metas')).toHaveText(/300,00/);
    await expectNoUntranslatedKeys(authedPage, '/cuentas');
  });

  test('RF-M4-10 el detalle de la cuenta, cargado de forma directa, muestra Saldo, Apartado para metas y Libre', async ({
    authedPage,
  }) => {
    const world = await seedWorld(authedPage);
    await load(authedPage, `/cuentas/${world.bankId}`);
    await expect(authedPage.getByText('Saldo', { exact: true })).toBeVisible();
    await expect(authedPage.getByText('Apartado para metas', { exact: true })).toBeVisible();
    await expect(authedPage.getByText('Libre', { exact: true })).toBeVisible();
    await expect(valueOf(authedPage, 'Saldo')).toHaveText(/4\.?800,00/);
    await expect(valueOf(authedPage, 'Apartado para metas')).toHaveText(/300,00/);
    await expect(valueOf(authedPage, 'Libre')).toHaveText(/4\.?500,00/);
    await expectNoUntranslatedKeys(authedPage, 'el detalle de la cuenta');
  });

  test('RF-M12-08 los apartados y la cuenta dedicada suman a la línea sin cambiar el total neto', async ({
    authedPage,
  }) => {
    const bank = await createAccount(authedPage, 'Banco', '4800.00', 'bank');
    const savings = await createAccount(authedPage, 'Ahorro', '850.00', 'savings');
    await load(authedPage, '/cuentas');
    const before = await authedPage.getByTestId('net-worth-base').innerText();
    expect(before).toMatch(/5\.?650,00/);

    const trip = await createGoal(authedPage, 'Viaje', '3000.00');
    await earmark(authedPage, trip, bank, '300.00');
    const house = await createGoal(authedPage, 'Casa', '9000.00');
    const dedicated = await authedPage.request.post(`/api/goals/${house}/dedicate`, {
      data: { accountId: savings },
    });
    expect(dedicated.ok(), 'POST /api/goals/:id/dedicate').toBe(true);

    await load(authedPage, '/cuentas');
    await expect(valueOf(authedPage, 'Apartado para metas')).toHaveText(/1\.?150,00/);
    await expect(authedPage.getByTestId('net-worth-base')).toHaveText(before);
    await expectNoUntranslatedKeys(authedPage, '/cuentas');
  });
});

test.describe('TASK-249 confirmación de apartados tras una carga directa', () => {
  test('RF-M12-05 registrar un gasto que usa apartados muestra la confirmación traducida', async ({
    authedPage,
  }) => {
    const bank = await createAccount(authedPage, 'Banco', '4800.00', 'bank');
    const goalId = await createGoal(authedPage, 'Viaje', '3000.00');
    await earmark(authedPage, goalId, bank, '300.00');
    const category = await expenseCategory(authedPage);
    await load(authedPage, '/registrar');
    await authedPage.getByLabel('Monto', { exact: true }).fill('4600');
    await authedPage
      .getByRole('button', { name: new RegExp(category.name) })
      .first()
      .click();
    await authedPage.getByRole('button', { name: 'Guardar', exact: true }).click();
    await expectConfirmTranslated(authedPage);
    await earmarkDialog(authedPage).getByRole('button', { name: 'Confirmar', exact: true }).click();
    await expect(authedPage.getByRole('dialog')).toHaveCount(0);
    expect(await progressOf(authedPage, goalId)).toBe(200);
  });

  test('EC-M7-03 al cancelar la confirmación traducida, el formulario de Registrar queda intacto', async ({
    authedPage,
  }) => {
    const bank = await createAccount(authedPage, 'Banco', '4800.00', 'bank');
    const goalId = await createGoal(authedPage, 'Viaje', '3000.00');
    await earmark(authedPage, goalId, bank, '300.00');
    const category = await expenseCategory(authedPage);
    await load(authedPage, '/registrar');
    await authedPage.getByLabel('Monto', { exact: true }).fill('4600');
    await authedPage
      .getByRole('button', { name: new RegExp(category.name) })
      .first()
      .click();
    await authedPage.getByRole('button', { name: 'Guardar', exact: true }).click();
    await expectConfirmTranslated(authedPage);
    await earmarkDialog(authedPage).getByRole('button', { name: 'Cancelar', exact: true }).click();
    await expect(authedPage.getByRole('dialog')).toHaveCount(0);
    await expect(authedPage.getByLabel('Monto', { exact: true })).toHaveValue(/4\.?600/);
    expect(await progressOf(authedPage, goalId)).toBe(300);
  });

  test('RF-M12-05 editar un movimiento que deja el saldo bajo lo apartado muestra la confirmación traducida', async ({
    authedPage,
  }) => {
    const bank = await createAccount(authedPage, 'Banco', '500.00', 'bank');
    const category = await expenseCategory(authedPage);
    const txId = await createTransaction(authedPage, 'expense', bank, category.id, '100');
    const goalId = await createGoal(authedPage, 'Viaje', '3000.00');
    await earmark(authedPage, goalId, bank, '400.00');
    await load(authedPage, `/movimientos/${txId}`);
    await authedPage.getByRole('button', { name: 'Editar', exact: true }).click();
    await authedPage.getByLabel('Monto', { exact: true }).fill('200');
    await authedPage.getByRole('button', { name: 'Guardar cambios' }).click();
    await expectConfirmTranslated(authedPage);
    await earmarkDialog(authedPage).getByRole('button', { name: 'Confirmar', exact: true }).click();
    await expect(authedPage.getByRole('dialog')).toHaveCount(0);
    await expect.poll(() => progressOf(authedPage, goalId)).toBe(300);
  });

  test('RF-M12-05 eliminar un ingreso que deja el saldo bajo lo apartado muestra la confirmación traducida', async ({
    authedPage,
  }) => {
    const bank = await createAccount(authedPage, 'Banco', '100.00', 'bank');
    const txId = await createTransaction(
      authedPage,
      'income',
      bank,
      await incomeCategoryId(authedPage),
      '500',
    );
    const goalId = await createGoal(authedPage, 'Viaje', '3000.00');
    await earmark(authedPage, goalId, bank, '400.00');
    await load(authedPage, `/movimientos/${txId}`);
    await authedPage.getByRole('button', { name: 'Eliminar', exact: true }).click();
    await expectConfirmTranslated(authedPage);
    await earmarkDialog(authedPage).getByRole('button', { name: 'Confirmar', exact: true }).click();
    await expect(authedPage.getByRole('dialog')).toHaveCount(0);
    await expect.poll(() => progressOf(authedPage, goalId)).toBe(100);
  });

  test('RF-M12-05 deshacer una eliminación que deja el saldo bajo lo apartado muestra la confirmación traducida', async ({
    authedPage,
  }) => {
    const bank = await createAccount(authedPage, 'Banco', '500.00', 'bank');
    const category = await expenseCategory(authedPage);
    const txId = await createTransaction(authedPage, 'expense', bank, category.id, '100');
    const goalId = await createGoal(authedPage, 'Viaje', '3000.00');
    await load(authedPage, `/movimientos/${txId}`);
    await authedPage.getByRole('button', { name: 'Eliminar', exact: true }).click();
    await expect(authedPage.getByText('Movimiento eliminado')).toBeVisible();
    await earmark(authedPage, goalId, bank, '500.00');
    await authedPage.getByRole('button', { name: 'Deshacer', exact: true }).click();
    await expectConfirmTranslated(authedPage);
    await earmarkDialog(authedPage).getByRole('button', { name: 'Confirmar', exact: true }).click();
    await expect(authedPage.getByRole('dialog')).toHaveCount(0);
    await expect.poll(() => progressOf(authedPage, goalId)).toBe(400);
  });

  test('RF-M12-05 ajustar el saldo bajo lo apartado muestra la confirmación traducida', async ({
    authedPage,
  }) => {
    const bank = await createAccount(authedPage, 'Banco', '500.00', 'bank');
    const goalId = await createGoal(authedPage, 'Viaje', '3000.00');
    await earmark(authedPage, goalId, bank, '400.00');
    await load(authedPage, `/cuentas/${bank}?ajustar=1`);
    await authedPage.getByLabel('Saldo real').fill('100');
    await authedPage.getByRole('button', { name: 'Ajustar', exact: true }).click();
    await expectConfirmTranslated(authedPage);
    await earmarkDialog(authedPage).getByRole('button', { name: 'Confirmar', exact: true }).click();
    await expect(authedPage.getByRole('dialog')).toHaveCount(0);
    await expect.poll(() => progressOf(authedPage, goalId)).toBe(100);
  });
});
