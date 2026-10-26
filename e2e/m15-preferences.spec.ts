import { randomUUID } from 'node:crypto';

import type { Locator, Page } from '@playwright/test';

import { expect, test } from './fixtures/auth.js';
import { expectNoBlockingViolations } from './support/axe.js';

type NotificationType =
  | 'payment_upcoming'
  | 'budget_alert'
  | 'period_close'
  | 'recurring_pending'
  | 'log_day'
  | 'goal_progress';

interface Preference {
  type: NotificationType;
  enabled: boolean;
  hour?: number;
  leadDays?: number;
  weekdays?: number[];
}

interface CategoryNode {
  id: string;
  kind: string;
  status: string;
  children: CategoryNode[];
}

interface Notification {
  id: string;
  type: string;
}

const PATH = '/ajustes/recordatorios';

/** The accessible name of the switch of each type, in the words of RF-M15-02. */
const SWITCH_NAMES: Record<NotificationType, RegExp> = {
  payment_upcoming: /pagos? próximos?/i,
  budget_alert: /alertas de presupuesto/i,
  period_close: /cierre de período/i,
  recurring_pending: /pendientes? de recurrentes?/i,
  log_day: /registrar el día/i,
  goal_progress: /avance de metas/i,
};

const TYPES = Object.keys(SWITCH_NAMES) as NotificationType[];

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

async function preferences(page: Page): Promise<Preference[]> {
  const res = await page.request.get('/api/notification-preferences');
  expect(res.ok()).toBe(true);
  return (await res.json()) as Preference[];
}

async function preferenceOf(page: Page, type: NotificationType): Promise<Preference | undefined> {
  return (await preferences(page)).find((p) => p.type === type);
}

function main(page: Page): Locator {
  return page.getByRole('main');
}

function switchOf(page: Page, type: NotificationType): Locator {
  return main(page).getByRole('switch', { name: SWITCH_NAMES[type] });
}

async function openPreferences(page: Page): Promise<void> {
  await page.goto(PATH);
  await expect(switchOf(page, 'recurring_pending')).toBeVisible();
}

/** Turns a type on from the page and waits until the change is saved. */
async function enableFromPage(page: Page, type: NotificationType): Promise<void> {
  const toggle = switchOf(page, type);
  if ((await toggle.getAttribute('aria-checked')) !== 'true') {
    await toggle.click();
  }
  await expect(toggle).toHaveAttribute('aria-checked', 'true');
  await expect.poll(async () => (await preferenceOf(page, type))?.enabled).toBe(true);
}

/** Sets a number control (native select, input or combobox) to `value`. */
async function setNumberControl(page: Page, control: Locator, value: number): Promise<void> {
  const tag = await control.evaluate((el) => el.tagName.toLowerCase());
  if (tag === 'select') {
    const options = await control.locator('option').evaluateAll((els) =>
      els.map((el) => ({ value: (el as HTMLOptionElement).value, label: el.textContent ?? '' })),
    );
    const found = options.find(
      (o) => o.value === String(value) || new RegExp(`^\\s*${value}\\b`).test(o.label),
    );
    expect(found, `option ${value}`).toBeDefined();
    await control.selectOption(found?.value ?? String(value));
    return;
  }
  if (tag === 'input') {
    await control.fill(String(value));
    await control.press('Tab');
    return;
  }
  await control.click();
  await page.getByRole('option', { name: new RegExp(`^\\s*${value}\\b`) }).first().click();
}

async function createAccount(page: Page): Promise<string> {
  const id = randomUUID();
  const res = await page.request.post('/api/accounts', {
    data: {
      id,
      type: 'cash',
      name: 'Efectivo',
      currencyCode: 'BOB',
      initialBalance: '500.00',
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

/** A rule in confirmation mode that starts today: its pending is generated at once. */
async function pendingOfToday(page: Page, name: string): Promise<void> {
  const accountId = await createAccount(page);
  const res = await page.request.post('/api/recurring', {
    data: {
      id: randomUUID(),
      name,
      kind: 'expense',
      amount: '40.00',
      accountId,
      categoryId: await expenseCategoryId(page),
      frequency: { type: 'daily' },
      startDate: localDate(),
      end: { type: 'none' },
      mode: 'confirm',
    },
  });
  expect(res.status()).toBe(201);
}

async function pendingNotices(page: Page): Promise<Notification[]> {
  const res = await page.request.get('/api/notifications?limit=50');
  expect(res.ok()).toBe(true);
  return ((await res.json()) as { items: Notification[] }).items.filter(
    (n) => n.type === 'recurring_pending',
  );
}

/** A pending of "Pendientes de confirmar" on Recurrentes, with its Confirmar button. */
function recurringPending(page: Page, ruleName: string): Locator {
  return page
    .locator('li, article, [role="listitem"], [role="group"], div')
    .filter({ hasText: ruleName })
    .filter({ has: page.getByRole('button', { name: 'Confirmar', exact: true }) })
    .last();
}

function bell(page: Page): Locator {
  return page.getByRole('banner').getByRole('button', { name: /avisos/i });
}

test.describe('TASK-241 Ajustes de recordatorios', () => {
  test('RF-M15-07 /ajustes lista Recordatorios y lleva a /ajustes/recordatorios', async ({
    authedPage,
  }) => {
    await authedPage.goto('/ajustes');
    const link = main(authedPage).getByRole('link', { name: /recordatorios/i });
    await expect(link).toBeVisible();
    await link.click();
    await expect(authedPage).toHaveURL(/\/ajustes\/recordatorios$/);
    await expect(switchOf(authedPage, 'recurring_pending')).toBeVisible();
  });

  test('RF-M15-07 en la V1.2 hay un interruptor por cada tipo con su valor por defecto', async ({
    authedPage,
  }) => {
    await openPreferences(authedPage);
    const saved = await preferences(authedPage);
    for (const type of TYPES) {
      const toggle = switchOf(authedPage, type);
      await expect(toggle, type).toBeVisible();
      const expected = saved.find((p) => p.type === type)?.enabled === true ? 'true' : 'false';
      await expect(toggle, type).toHaveAttribute('aria-checked', expected);
    }
    await expect(switchOf(authedPage, 'recurring_pending')).toHaveAttribute(
      'aria-checked',
      'true',
    );
    await expect(switchOf(authedPage, 'log_day')).toHaveAttribute('aria-checked', 'false');
  });

  test('RF-M15-07 "Registrar el día" ofrece la hora y los días de la semana', async ({
    authedPage,
  }) => {
    await openPreferences(authedPage);
    await enableFromPage(authedPage, 'log_day');
    await expect(main(authedPage).getByLabel(/hora/i).first()).toBeVisible();
    await expect(
      main(authedPage).getByRole('group', { name: /días de la semana/i }),
    ).toBeVisible();
  });

  test('RF-M15-07 la anticipación de "Pago próximo" se elige de 0 a 7 días y se guarda al instante', async ({
    authedPage,
  }) => {
    await openPreferences(authedPage);
    await enableFromPage(authedPage, 'payment_upcoming');
    const lead = main(authedPage).getByLabel(/anticipación/i).first();
    await expect(lead).toBeVisible();
    await setNumberControl(authedPage, lead, 5);
    await expect
      .poll(async () => (await preferenceOf(authedPage, 'payment_upcoming'))?.leadDays)
      .toBe(5);
  });

  test('RF-M15-03 todos los tipos se pueden desactivar y el cambio se guarda al instante', async ({
    authedPage,
  }) => {
    await openPreferences(authedPage);
    for (const type of TYPES) {
      const toggle = switchOf(authedPage, type);
      if ((await toggle.getAttribute('aria-checked')) === 'true') {
        await toggle.click();
      }
      await expect(toggle, type).toHaveAttribute('aria-checked', 'false');
    }
    await expect
      .poll(async () => (await preferences(authedPage)).filter((p) => p.enabled).map((p) => p.type))
      .toEqual([]);

    await authedPage.reload();
    for (const type of TYPES) {
      await expect(switchOf(authedPage, type), type).toHaveAttribute('aria-checked', 'false');
    }
  });

  test('RF-M15-03 Decisión visible con el aviso desactivado: el pendiente no llega a la bandeja y sí a Recurrentes', async ({
    authedPage,
  }) => {
    // Dado que el usuario desactivó los avisos de pendientes de recurrentes
    await openPreferences(authedPage);
    const toggle = switchOf(authedPage, 'recurring_pending');
    await expect(toggle).toHaveAttribute('aria-checked', 'true');
    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-checked', 'false');
    await expect
      .poll(async () => (await preferenceOf(authedPage, 'recurring_pending'))?.enabled)
      .toBe(false);

    // Cuando se genera un pendiente
    await pendingOfToday(authedPage, 'Internet silenciado');

    // Y sí aparece en "Pendientes de confirmar" de Recurrentes
    await authedPage.goto('/recurrentes');
    await expect(
      authedPage.getByRole('heading', { name: 'Pendientes de confirmar' }),
    ).toBeVisible();
    await expect(recurringPending(authedPage, 'Internet silenciado')).toBeVisible();

    // Entonces no aparece en la bandeja
    expect(await pendingNotices(authedPage)).toHaveLength(0);
    await expect(bell(authedPage)).toBeVisible();
    await bell(authedPage).click();
    const inbox = authedPage.getByRole('dialog').first();
    await expect(inbox).toBeVisible();
    await expect(inbox.getByText('Internet silenciado')).toHaveCount(0);
  });

  test('RNF-06 los interruptores se alcanzan con Tab y se cambian con la barra espaciadora', async ({
    authedPage,
  }) => {
    await openPreferences(authedPage);
    const toggle = switchOf(authedPage, 'goal_progress');
    await expect(toggle).toHaveAttribute('aria-checked', 'false');

    let reached = false;
    for (let i = 0; i < 60 && !reached; i += 1) {
      await authedPage.keyboard.press('Tab');
      reached = await toggle.evaluate((el) => el === document.activeElement);
    }
    expect(reached, 'the switch of "Avance de metas" is reachable with Tab').toBe(true);

    await authedPage.keyboard.press('Space');
    await expect(toggle).toHaveAttribute('aria-checked', 'true');
    await expect
      .poll(async () => (await preferenceOf(authedPage, 'goal_progress'))?.enabled)
      .toBe(true);

    await authedPage.keyboard.press('Space');
    await expect(toggle).toHaveAttribute('aria-checked', 'false');
    await expect
      .poll(async () => (await preferenceOf(authedPage, 'goal_progress'))?.enabled)
      .toBe(false);
  });

  test('RNF-06 /ajustes/recordatorios no tiene violaciones de axe, con los controles de cada tipo a la vista', async ({
    authedPage,
  }) => {
    await openPreferences(authedPage);
    await enableFromPage(authedPage, 'log_day');
    await enableFromPage(authedPage, 'payment_upcoming');
    await expectNoBlockingViolations(authedPage);
  });

  test('RF-M15-07 @release-1.0 con una entrega anterior a la V1.2 Ajustes no muestra Recordatorios', async ({
    authedPage,
  }) => {
    await authedPage.goto('/ajustes');
    await expect(main(authedPage).getByRole('link', { name: /general/i })).toBeVisible();
    await expect(main(authedPage).getByRole('link', { name: /recordatorios/i })).toHaveCount(0);
  });
});
