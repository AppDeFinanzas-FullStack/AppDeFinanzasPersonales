import { randomUUID } from 'node:crypto';

import type { Locator, Page } from '@playwright/test';

import { expect, test } from './fixtures/auth.js';

interface CategoryNode {
  id: string;
  kind: string;
  status: string;
  children: CategoryNode[];
}

interface Decision {
  kind: 'budget_period' | 'occurrence';
  ref: string;
  status: 'waiting' | 'resolved';
}

interface Notification {
  id: string;
  type: string;
  decision?: Decision;
}

interface Movement {
  id: string;
  origin: string;
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

async function createAccount(page: Page, initialBalance: string): Promise<string> {
  const id = randomUUID();
  const res = await page.request.post('/api/accounts', {
    data: {
      id,
      type: 'cash',
      name: 'Efectivo',
      currencyCode: 'BOB',
      initialBalance,
      initialBalanceDate: localDate(-40),
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
  frequency: Record<string, unknown>;
  startDate: string;
}

async function createRule(page: Page, options: RuleOptions): Promise<void> {
  const res = await page.request.post('/api/recurring', {
    data: {
      id: randomUUID(),
      name: options.name,
      kind: 'expense',
      amount: '40.00',
      accountId: options.accountId,
      categoryId: await expenseCategoryId(page),
      frequency: options.frequency,
      startDate: options.startDate,
      end: { type: 'none' },
      mode: options.mode,
    },
  });
  expect(res.status()).toBe(201);
}

/** A rule in confirmation mode that starts today: its pending and its notice exist at once. */
async function pendingOfToday(page: Page, name: string): Promise<string> {
  const cash = await createAccount(page, '500.00');
  await createRule(page, {
    name,
    accountId: cash,
    mode: 'confirm',
    frequency: { type: 'daily' },
    startDate: localDate(),
  });
  return cash;
}

async function pendingNotices(page: Page): Promise<Notification[]> {
  const res = await page.request.get('/api/notifications?limit=50');
  expect(res.ok()).toBe(true);
  return ((await res.json()) as { items: Notification[] }).items.filter(
    (n) => n.type === 'recurring_pending',
  );
}

async function recurringMovements(page: Page, accountId: string): Promise<Movement[]> {
  const res = await page.request.get(`/api/transactions?accountId=${accountId}`);
  expect(res.ok()).toBe(true);
  return ((await res.json()) as { items: Movement[] }).items.filter(
    (m) => m.origin === 'recurring',
  );
}

function bell(page: Page): Locator {
  return page.getByRole('banner').getByRole('button', { name: /avisos/i });
}

/** The inbox, the Sheet opened from the bell: the dialog that holds the notifications list. */
function panel(page: Page): Locator {
  return page
    .getByRole('dialog')
    .filter({ has: page.getByRole('listitem') })
    .first();
}

function inboxItem(page: Page): Locator {
  return panel(page).getByRole('listitem').first();
}

async function openInbox(page: Page): Promise<void> {
  await page.goto('/');
  await expect(bell(page)).toBeVisible();
  await bell(page).click();
  await expect(panel(page)).toBeVisible();
}

/** A pending of "Pendientes de confirmar" on Recurrentes, with its Confirmar button. */
function recurringPending(page: Page, ruleName: string): Locator {
  return page
    .locator('li, article, [role="listitem"], [role="group"], div')
    .filter({ hasText: ruleName })
    .filter({ has: page.getByRole('button', { name: 'Confirmar', exact: true }) })
    .last();
}

/**
 * If the confirmation of the pending asks for its data in a dialog (the one with "Fecha"), accept
 * it with its own Confirmar button.
 */
async function acceptConfirmDialogIfAny(page: Page): Promise<void> {
  const dialog = page.getByRole('dialog').filter({ has: page.getByLabel('Fecha') });
  if ((await dialog.count()) > 0 && (await dialog.first().isVisible())) {
    await dialog.first().getByRole('button', { name: 'Confirmar', exact: true }).click();
  }
}

test.describe('TASK-236 pendientes en la bandeja', () => {
  test('TASK-236 un aviso de pendiente muestra los botones Confirmar y Omitir en la bandeja', async ({
    authedPage,
  }) => {
    await pendingOfToday(authedPage, 'Internet bandeja');
    await expect.poll(async () => (await pendingNotices(authedPage)).length).toBe(1);

    await openInbox(authedPage);
    const item = inboxItem(authedPage);
    await expect(item.getByRole('button', { name: 'Confirmar', exact: true })).toBeVisible();
    await expect(item.getByRole('button', { name: 'Omitir', exact: true })).toBeVisible();
  });

  test('EC-M15-01 confirmar desde la bandeja deja el aviso Resuelto y el pendiente desaparece de Recurrentes', async ({
    authedPage,
  }) => {
    const cash = await pendingOfToday(authedPage, 'Agua bandeja');
    await expect.poll(async () => (await pendingNotices(authedPage)).length).toBe(1);

    await openInbox(authedPage);
    await inboxItem(authedPage).getByRole('button', { name: 'Confirmar', exact: true }).click();
    await expect
      .poll(
        async () => {
          await acceptConfirmDialogIfAny(authedPage);
          return (await pendingNotices(authedPage)).map((n) => n.decision?.status);
        },
        { timeout: 15_000 },
      )
      .toEqual(['resolved']);
    await expect.poll(async () => (await recurringMovements(authedPage, cash)).length).toBe(1);

    await authedPage.goto('/recurrentes');
    await expect(
      authedPage.getByRole('heading', { name: 'Pendientes de confirmar' }),
    ).toBeVisible();
    await expect(recurringPending(authedPage, 'Agua bandeja')).toHaveCount(0);
  });

  test('EC-M15-01 omitir desde la bandeja deja el aviso Resuelto y no registra el movimiento', async ({
    authedPage,
  }) => {
    const cash = await pendingOfToday(authedPage, 'Cable bandeja');
    await expect.poll(async () => (await pendingNotices(authedPage)).length).toBe(1);

    await openInbox(authedPage);
    await inboxItem(authedPage).getByRole('button', { name: 'Omitir', exact: true }).click();
    await expect
      .poll(async () => (await pendingNotices(authedPage)).map((n) => n.decision?.status), {
        timeout: 15_000,
      })
      .toEqual(['resolved']);
    expect(await recurringMovements(authedPage, cash)).toHaveLength(0);

    await authedPage.goto('/recurrentes');
    await expect(
      authedPage.getByRole('heading', { name: 'Pendientes de confirmar' }),
    ).toBeVisible();
    await expect(recurringPending(authedPage, 'Cable bandeja')).toHaveCount(0);
  });

  test('EC-M15-01 un pendiente resuelto desde Recurrentes deja su aviso Resuelto, sin botones en la bandeja', async ({
    authedPage,
  }) => {
    await pendingOfToday(authedPage, 'Gas bandeja');
    await expect.poll(async () => (await pendingNotices(authedPage)).length).toBe(1);

    await authedPage.goto('/recurrentes');
    await recurringPending(authedPage, 'Gas bandeja')
      .getByRole('button', { name: 'Omitir', exact: true })
      .click();
    await expect(recurringPending(authedPage, 'Gas bandeja')).toHaveCount(0);
    await expect
      .poll(async () => (await pendingNotices(authedPage)).map((n) => n.decision?.status))
      .toEqual(['resolved']);

    await openInbox(authedPage);
    const item = inboxItem(authedPage);
    await expect(item).toBeVisible();
    await expect(item.getByRole('button', { name: 'Confirmar', exact: true })).toHaveCount(0);
    await expect(item.getByRole('button', { name: 'Omitir', exact: true })).toHaveCount(0);
  });
});

test.describe('TASK-236 recurrentes en el Inicio', () => {
  test('RF-M8-09 un recurrente que vence en 3 días aparece en "Próximos pagos y deudas"', async ({
    authedPage,
  }) => {
    const in3 = localDate(3);
    const cash = await createAccount(authedPage, '500.00');
    await createRule(authedPage, {
      name: 'Alquiler pronto',
      accountId: cash,
      mode: 'auto',
      frequency: { type: 'monthly', day: Number(in3.slice(8, 10)) },
      startDate: in3,
    });

    await authedPage.goto('/');
    const block = authedPage.getByRole('region', { name: 'Próximos pagos y deudas' });
    await expect(block).toBeVisible();
    await expect(block.getByText('Alquiler pronto')).toBeVisible();
  });
});
