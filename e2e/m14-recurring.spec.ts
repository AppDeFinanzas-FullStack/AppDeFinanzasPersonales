import { randomUUID } from 'node:crypto';

import type { Locator, Page } from '@playwright/test';

import { expect, test } from './fixtures/auth.js';

interface CategoryNode {
  id: string;
  name: string;
  kind: string;
  status: string;
  children: CategoryNode[];
}

interface Movement {
  id: string;
  kind: string;
  date: string;
  origin: string;
  entries: { accountId: string; amount: string; currencyCode: string }[];
}

interface MovementPage {
  items: Movement[];
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

async function createAccount(page: Page, name: string, initialBalance: string): Promise<string> {
  const id = randomUUID();
  const res = await page.request.post('/api/accounts', {
    data: {
      id,
      type: 'cash',
      name,
      currencyCode: 'BOB',
      initialBalance,
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

interface RuleOptions {
  name: string;
  accountId: string;
  mode: 'auto' | 'confirm';
  amount?: string;
  startDate?: string;
  end?: { type: 'none' } | { type: 'count'; count: number };
}

async function createRule(page: Page, options: RuleOptions): Promise<string> {
  const id = randomUUID();
  const data: Record<string, unknown> = {
    id,
    name: options.name,
    kind: 'expense',
    accountId: options.accountId,
    categoryId: await expenseCategoryId(page),
    frequency: { type: 'daily' },
    startDate: options.startDate ?? localDate(),
    end: options.end ?? { type: 'none' },
    mode: options.mode,
  };
  if (options.amount !== undefined) data['amount'] = options.amount;
  const res = await page.request.post('/api/recurring', { data });
  expect(res.status()).toBe(201);
  return id;
}

async function recurringMovements(page: Page, accountId: string): Promise<Movement[]> {
  const res = await page.request.get(`/api/transactions?accountId=${accountId}`);
  expect(res.ok()).toBe(true);
  return ((await res.json()) as MovementPage).items.filter((m) => m.origin === 'recurring');
}

/**
 * A pending of "Pendientes de confirmar" (RF-M14-13): the smallest block that holds the rule name
 * and its Confirmar button. Only pendings have Confirmar and Omitir.
 */
function pendingItem(page: Page, ruleName: string): Locator {
  return page
    .locator('li, article, [role="listitem"], [role="group"], div')
    .filter({ hasText: ruleName })
    .filter({ has: page.getByRole('button', { name: 'Confirmar', exact: true }) })
    .last();
}

test.describe('TASK-234 pantalla de Recurrentes', () => {
  test('RF-M14-13 Automático bloqueado pasa a pendiente: el pendiente se ve en "Pendientes de confirmar"', async ({
    authedPage,
  }) => {
    const cash = await createAccount(authedPage, 'Efectivo', '30.00');
    await createRule(authedPage, {
      name: 'Pasaje',
      accountId: cash,
      mode: 'auto',
      amount: '50.00',
    });
    expect(await recurringMovements(authedPage, cash)).toHaveLength(0);

    await authedPage.goto('/recurrentes');
    await expect(
      authedPage.getByRole('heading', { name: 'Pendientes de confirmar' }),
    ).toBeVisible();
    await expect(pendingItem(authedPage, 'Pasaje')).toBeVisible();
    await expect(
      pendingItem(authedPage, 'Pasaje').getByRole('button', { name: 'Confirmar' }),
    ).toBeVisible();
    await expect(
      pendingItem(authedPage, 'Pasaje').getByRole('button', { name: 'Omitir' }),
    ).toBeVisible();
  });

  test('RF-M14-13 la pantalla muestra las reglas, "Próximos vencimientos" y "Cuota X de N"', async ({
    authedPage,
  }) => {
    const cash = await createAccount(authedPage, 'Efectivo', '500.00');
    await createRule(authedPage, {
      name: 'Gimnasio',
      accountId: cash,
      mode: 'confirm',
      amount: '20.00',
      startDate: localDate(1),
      end: { type: 'count', count: 5 },
    });

    await authedPage.goto('/recurrentes');
    await expect(authedPage.getByText('Gimnasio').first()).toBeVisible();
    await expect(authedPage.getByText(/Cuota \d+ de 5/).first()).toBeVisible();
    await expect(
      authedPage.getByRole('heading', { name: 'Pendientes de confirmar' }),
    ).toBeVisible();
    await expect(
      authedPage.getByRole('heading', { name: 'Próximos vencimientos' }),
    ).toBeVisible();
  });

  test('RF-M14-08 confirmar con otra fecha registra el movimiento en esa fecha', async ({
    authedPage,
  }) => {
    const cash = await createAccount(authedPage, 'Efectivo', '500.00');
    await createRule(authedPage, {
      name: 'Internet',
      accountId: cash,
      mode: 'confirm',
      amount: '40.00',
    });
    const otherDate = localDate(-2);

    await authedPage.goto('/recurrentes');
    await pendingItem(authedPage, 'Internet').getByRole('button', { name: 'Confirmar' }).click();
    const dialog = authedPage.getByRole('dialog');
    await expect(dialog).toBeVisible();
    await dialog.getByLabel('Fecha').fill(otherDate);
    await dialog.getByRole('button', { name: 'Confirmar' }).click();
    await expect(authedPage.getByRole('dialog')).toHaveCount(0);
    await expect(pendingItem(authedPage, 'Internet')).toHaveCount(0);

    await expect
      .poll(async () => (await recurringMovements(authedPage, cash)).map((m) => m.date))
      .toEqual([otherDate]);
  });

  test('RF-M14-14 una regla sin monto muestra "monto por definir" y pide el monto al confirmar', async ({
    authedPage,
  }) => {
    const cash = await createAccount(authedPage, 'Efectivo', '500.00');
    await createRule(authedPage, { name: 'Luz', accountId: cash, mode: 'confirm' });

    await authedPage.goto('/recurrentes');
    await expect(authedPage.getByText(/monto por definir/i).first()).toBeVisible();

    await pendingItem(authedPage, 'Luz').getByRole('button', { name: 'Confirmar' }).click();
    const dialog = authedPage.getByRole('dialog');
    await expect(dialog).toBeVisible();
    const amount = dialog.getByLabel('Monto', { exact: true });
    await expect(amount).toHaveValue('');
    await dialog.getByRole('button', { name: 'Confirmar' }).click();
    await expect(dialog).toBeVisible();
    expect(await recurringMovements(authedPage, cash)).toHaveLength(0);

    await amount.fill('85.50');
    await dialog.getByRole('button', { name: 'Confirmar' }).click();
    await expect(authedPage.getByRole('dialog')).toHaveCount(0);

    await expect
      .poll(async () =>
        (await recurringMovements(authedPage, cash)).map((m) =>
          m.entries.map((e) => Math.abs(Number(e.amount))),
        ),
      )
      .toEqual([[85.5]]);
  });
});
