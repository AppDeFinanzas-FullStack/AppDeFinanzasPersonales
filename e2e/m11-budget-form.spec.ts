import { randomUUID } from 'node:crypto';

import type { Locator, Page } from '@playwright/test';

import { expect, test } from './fixtures/auth.js';

const ZONE = 'America/La_Paz';

/** Year, month (1-12) and day of today in the zone of the test user, never the UTC day. */
function localToday(): { year: number; month: number; day: number } {
  const [year, month, day] = new Intl.DateTimeFormat('en-CA', { timeZone: ZONE })
    .format(new Date())
    .split('-')
    .map(Number);
  return { year: year ?? 0, month: month ?? 0, day: day ?? 0 };
}

interface CategoryNode {
  id: string;
  name: string;
  kind: string;
  status: string;
  isSystem?: boolean;
  children: CategoryNode[];
}

/** An active expense category the user can budget (not "Deudas y préstamos"). */
async function budgetableCategory(page: Page): Promise<{ id: string; name: string }> {
  const res = await page.request.get('/api/categories?kind=expense&status=active');
  expect(res.ok()).toBe(true);
  const roots = (await res.json()) as CategoryNode[];
  const node = roots.find(
    (n) => n.kind === 'expense' && n.status === 'active' && n.isSystem !== true,
  );
  expect(node).toBeDefined();
  return { id: node?.id ?? '', name: node?.name ?? '' };
}

async function createBudget(page: Page, data: Record<string, unknown>): Promise<string> {
  const id = randomUUID();
  const res = await page.request.post('/api/budgets', {
    data: { id, amount: '500.00', currencyCode: 'BOB', ...data },
  });
  expect(res.status()).toBe(201);
  return id;
}

async function listBudgets(page: Page): Promise<{ id: string; scope: string; startDay: number }[]> {
  const res = await page.request.get('/api/budgets');
  expect(res.ok()).toBe(true);
  const body = (await res.json()) as {
    items: { id: string; scope: string; startDay: number }[];
  };
  return body.items;
}

async function openNewForm(page: Page): Promise<Locator> {
  await page.goto('/presupuestos');
  await page
    .getByRole('button', { name: /nuevo presupuesto|crear presupuesto/i })
    .first()
    .click();
  const dialog = page.getByRole('dialog');
  await expect(dialog).toBeVisible();
  return dialog;
}

async function openEditForm(page: Page, id: string): Promise<Locator> {
  await page.goto(`/presupuestos/${id}`);
  const button = page.getByRole('button', { name: /^editar/i });
  if ((await button.count()) > 0) {
    await button.first().click();
  } else {
    await page
      .getByRole('button', { name: /acciones|opciones|más/i })
      .first()
      .click();
    await page.getByRole('menuitem', { name: /editar/i }).click();
  }
  const dialog = page.getByRole('dialog');
  await expect(dialog).toBeVisible();
  return dialog;
}

/** Sets a field that may be a native select, a combobox (shadcn Select) or a text input. */
async function setField(page: Page, field: Locator, label: string | RegExp): Promise<void> {
  const tag = await field.evaluate((el) => el.tagName.toLowerCase());
  if (tag === 'select') {
    const options = await field.locator('option').allTextContents();
    const match = options.find((o) =>
      typeof label === 'string' ? o.trim() === label : label.test(o),
    );
    await field.selectOption({ label: match ?? String(label) });
    return;
  }
  if (tag === 'input' && (await field.getAttribute('role')) !== 'combobox') {
    await field.fill(typeof label === 'string' ? label : '');
    return;
  }
  await field.click();
  await page
    .getByRole('option', { name: typeof label === 'string' ? new RegExp(`^${label}$`) : label })
    .first()
    .click();
}

const scopeField = (dialog: Locator): Locator => dialog.getByLabel(/alcance/i).first();
const amountField = (dialog: Locator): Locator => dialog.getByLabel(/monto/i).first();
const startDayField = (dialog: Locator): Locator => dialog.getByLabel(/día de inicio/i).first();
const saveButton = (dialog: Locator): Locator =>
  dialog.getByRole('button', { name: /guardar|crear/i }).last();

const MONTHS = [
  'enero',
  'febrero',
  'marzo',
  'abril',
  'mayo',
  'junio',
  'julio',
  'agosto',
  'septiembre',
  'octubre',
  'noviembre',
  'diciembre',
];

test.describe('TASK-206 formulario de presupuesto', () => {
  test('RF-M11-01 "Deudas y préstamos" no se ofrece como alcance', async ({ authedPage }) => {
    const category = await budgetableCategory(authedPage);
    const dialog = await openNewForm(authedPage);
    const scope = scopeField(dialog);
    const tag = await scope.evaluate((el) => el.tagName.toLowerCase());
    if (tag === 'select') {
      const options = (await scope.locator('option').allTextContents()).map((o) => o.trim());
      expect(options).toContain(category.name);
      expect(options.some((o) => /general/i.test(o))).toBe(true);
      expect(options.some((o) => /^deudas y préstamos$/i.test(o))).toBe(false);
    } else {
      await scope.click();
      await expect(
        authedPage.getByRole('option', { name: new RegExp(`^${category.name}$`) }).first(),
      ).toBeVisible();
      await expect(authedPage.getByRole('option', { name: /general/i }).first()).toBeVisible();
      await expect(authedPage.getByRole('option', { name: /^deudas y préstamos$/i })).toHaveCount(
        0,
      );
    }
  });

  test('RF-M11-01 crear un presupuesto general desde el formulario', async ({ authedPage }) => {
    const dialog = await openNewForm(authedPage);
    await setField(authedPage, scopeField(dialog), /general/i);
    await amountField(dialog).fill('1000');
    await saveButton(dialog).click();
    await expect(authedPage.getByRole('dialog')).toHaveCount(0);
    const items = await listBudgets(authedPage);
    expect(items).toHaveLength(1);
    expect(items[0]?.scope).toBe('general');
  });

  test('RF-M9-06 cada presupuesto se configura por separado: día de inicio, acción y umbrales', async ({
    authedPage,
  }) => {
    const dialog = await openNewForm(authedPage);
    await expect(dialog.getByText(/moneda/i).first()).toBeVisible();
    await expect(dialog.getByText(/día de inicio/i).first()).toBeVisible();
    await expect(dialog.getByText(/acción/i).first()).toBeVisible();
    await expect(dialog.getByText(/umbral/i).first()).toBeVisible();
    await setField(authedPage, scopeField(dialog), /general/i);
    await amountField(dialog).fill('800');
    await setField(authedPage, startDayField(dialog), '5');
    await saveButton(dialog).click();
    await expect(authedPage.getByRole('dialog')).toHaveCount(0);
    const items = await listBudgets(authedPage);
    expect(items).toHaveLength(1);
    expect(items[0]?.startDay).toBe(5);
  });

  test('EC-M11-06 crear un segundo presupuesto para la misma categoría ofrece editar el existente', async ({
    authedPage,
  }) => {
    const category = await budgetableCategory(authedPage);
    const existing = await createBudget(authedPage, {
      scope: 'category',
      categoryId: category.id,
      amount: '500.00',
    });
    const dialog = await openNewForm(authedPage);
    await setField(authedPage, scopeField(dialog), category.name);
    await amountField(dialog).fill('900');
    await saveButton(dialog).click();

    const offer = authedPage
      .getByRole('dialog')
      .getByRole('button', { name: /editar/i })
      .or(authedPage.getByRole('dialog').getByRole('link', { name: /editar/i }));
    await expect(offer.first()).toBeVisible();
    const items = await listBudgets(authedPage);
    expect(items).toHaveLength(1);
    expect(items[0]?.id).toBe(existing);

    await offer.first().click();
    await expect(amountField(authedPage.getByRole('dialog'))).toHaveValue(/^500([.,]00)?$/);
  });

  test('RF-M11-07 cambiar el día de inicio muestra la fecha de fin del período alargado', async ({
    authedPage,
  }) => {
    const id = await createBudget(authedPage, { scope: 'general', startDay: 1 });
    const { year, month } = localToday();
    // The period in course (from day 1) lengthens until the day before the new start day (15).
    const nextMonth = month === 12 ? 1 : month + 1;
    const endYear = month === 12 ? year + 1 : year;
    const mm = String(nextMonth).padStart(2, '0');
    const name = MONTHS[nextMonth - 1] ?? '';
    const endPattern = new RegExp(
      `14( de)? (${name}|${name.slice(0, 3)})|14/${mm}(/${endYear})?|${endYear}-${mm}-14`,
      'i',
    );

    const dialog = await openEditForm(authedPage, id);
    await setField(authedPage, startDayField(dialog), '15');
    await saveButton(dialog).click();
    await expect(authedPage.getByText(endPattern).first()).toBeVisible();
  });

  test('RF-M11-07 al editar no se puede cambiar la moneda', async ({ authedPage }) => {
    const id = await createBudget(authedPage, { scope: 'general' });
    const dialog = await openEditForm(authedPage, id);
    await expect(amountField(dialog)).toBeVisible();
    const currency = dialog.getByLabel(/moneda/i);
    if ((await currency.count()) > 0) {
      await expect(currency.first()).toBeDisabled();
    }
  });
});
