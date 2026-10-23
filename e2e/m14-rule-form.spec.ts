import { randomUUID } from 'node:crypto';

import type { Locator, Page } from '@playwright/test';

import { expect, test } from './fixtures/auth.js';

interface CategoryNode {
  id: string;
  kind: string;
  status: string;
  children: CategoryNode[];
}

interface RuleSummary {
  id: string;
  name: string;
  mode: string;
}

interface RecurringOverview {
  rules: RuleSummary[];
}

/** The user's local date (RN-07); the test users live in Bolivia. */
function localDate(offsetDays = 0): string {
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

async function createAccount(page: Page, name: string): Promise<string> {
  const id = randomUUID();
  const res = await page.request.post('/api/accounts', {
    data: {
      id,
      type: 'cash',
      name,
      currencyCode: 'BOB',
      initialBalance: '500.00',
      initialBalanceDate: localDate(-7),
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

async function createWeeklyRule(page: Page, name: string, accountId: string): Promise<string> {
  const id = randomUUID();
  const res = await page.request.post('/api/recurring', {
    data: {
      id,
      name,
      kind: 'expense',
      accountId,
      categoryId: await expenseCategoryId(page),
      amount: '30.00',
      frequency: { type: 'weekly', weekday: 1 },
      startDate: localDate(1),
      end: { type: 'none' },
      mode: 'confirm',
    },
  });
  expect(res.status()).toBe(201);
  return id;
}

async function ruleNames(page: Page): Promise<string[]> {
  const res = await page.request.get('/api/recurring');
  expect(res.ok()).toBe(true);
  return ((await res.json()) as RecurringOverview).rules.map((r) => r.name);
}

async function openNewRuleForm(page: Page): Promise<Locator> {
  await page.goto('/recurrentes');
  await page.getByRole('button', { name: 'Nueva regla' }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog).toBeVisible();
  return dialog;
}

test.describe('TASK-235 formulario de regla y diálogo de reanudar', () => {
  test('RF-M14-01 el formulario ofrece las frecuencias diaria, semanal, mensual y anual', async ({
    authedPage,
  }) => {
    await createAccount(authedPage, 'Efectivo');
    const dialog = await openNewRuleForm(authedPage);

    await dialog.getByLabel('Frecuencia').click();
    for (const label of ['Diaria', 'Semanal', 'Mensual', 'Anual']) {
      await expect(authedPage.getByRole('option', { name: label })).toBeVisible();
    }
  });

  test('RF-M14-03 el calendario de inicio no permite fechas pasadas', async ({ authedPage }) => {
    await createAccount(authedPage, 'Efectivo');
    const dialog = await openNewRuleForm(authedPage);

    const start = dialog.getByLabel('Inicio');
    await expect(start).toHaveAttribute('min', localDate());

    await dialog.getByLabel('Nombre').fill('Regla pasada');
    await dialog.getByLabel('Monto', { exact: true }).fill('10.00');
    await start.fill(localDate(-3));
    await dialog.getByRole('button', { name: 'Guardar' }).click();
    await expect(dialog).toBeVisible();
    expect(await ruleNames(authedPage)).not.toContain('Regla pasada');
  });

  test('RF-M14-14 en modo automático el monto es obligatorio', async ({ authedPage }) => {
    await createAccount(authedPage, 'Efectivo');
    const dialog = await openNewRuleForm(authedPage);

    await dialog.getByLabel('Nombre').fill('Alquiler auto');
    await dialog.getByRole('radio', { name: 'Automático' }).check();
    await dialog.getByRole('button', { name: 'Guardar' }).click();

    await expect(dialog).toBeVisible();
    await expect(
      dialog.getByText(/monto/i).filter({ hasText: /ingresa|obligatorio/i }),
    ).toBeVisible();
    expect(await ruleNames(authedPage)).not.toContain('Alquiler auto');
  });

  test('RF-M14-14 en modo confirmación el monto es opcional', async ({ authedPage }) => {
    await createAccount(authedPage, 'Efectivo');
    const dialog = await openNewRuleForm(authedPage);

    await dialog.getByLabel('Nombre').fill('Agua sin monto');
    await dialog.getByRole('radio', { name: 'Con confirmación' }).check();
    await dialog.getByRole('button', { name: 'Guardar' }).click();

    await expect(authedPage.getByRole('dialog')).toHaveCount(0);
    await expect.poll(() => ruleNames(authedPage)).toContain('Agua sin monto');
    await expect(authedPage.getByText(/monto por definir/i).first()).toBeVisible();
  });

  test('RF-M14-09 Reanudar con ocurrencias saltadas: la app pregunta por las 3 saltadas', async ({
    authedPage,
  }) => {
    const cash = await createAccount(authedPage, 'Efectivo');
    const ruleId = await createWeeklyRule(authedPage, 'Gimnasio semanal', cash);
    const pause = await authedPage.request.post(`/api/recurring/${ruleId}/pause`);
    expect(pause.ok()).toBe(true);

    const skipped = [localDate(-21), localDate(-14), localDate(-7)];
    await authedPage.route(`**/api/recurring/${ruleId}/skipped`, (route) =>
      route.fulfill({ status: 200, json: { dates: skipped } }),
    );

    await authedPage.goto('/recurrentes');
    await authedPage.getByRole('button', { name: 'Reanudar' }).first().click();

    const dialog = authedPage.getByRole('dialog');
    await expect(dialog).toBeVisible();
    await expect(dialog.getByRole('checkbox')).toHaveCount(3);
  });
});
