import { randomUUID } from 'node:crypto';

import type { Locator, Page } from '@playwright/test';

import { expect, test, type TestUser } from './fixtures/auth.js';
import { expectNoBlockingViolations } from './support/axe.js';

const API_URL = `http://localhost:${process.env['API_PORT'] ?? '3000'}`;

interface Decision {
  kind: 'budget_period' | 'occurrence';
  ref: string;
  status: 'waiting' | 'resolved';
}

interface Notification {
  id: string;
  type: string;
  targetRoute: string;
  read: boolean;
  decision?: Decision;
}

interface NotificationsPage {
  items: Notification[];
  nextCursor: string | null;
}

interface NewNotification {
  type: 'payment_upcoming' | 'budget_alert' | 'period_close';
  targetRoute: string;
  params?: Record<string, unknown>;
  decision?: { kind: 'budget_period' | 'occurrence'; ref: string };
}

/**
 * Creates a notification for the user with `POST /internal/test/notifications` (only with
 * `INTEGRATIONS=fake`). The request carries the session of the page and the user's email.
 */
async function createNotification(page: Page, user: TestUser, input: NewNotification): Promise<void> {
  const res = await page.request.post(`${API_URL}/internal/test/notifications`, {
    data: {
      email: user.email,
      eventKey: `e2e:${randomUUID()}`,
      params: {},
      ...input,
    },
  });
  expect(res.status()).toBe(201);
}

async function listNotifications(page: Page): Promise<Notification[]> {
  const res = await page.request.get('/api/notifications?limit=50');
  expect(res.ok()).toBe(true);
  return ((await res.json()) as NotificationsPage).items;
}

async function unreadCount(page: Page): Promise<number> {
  const res = await page.request.get('/api/notifications/unread-count');
  expect(res.ok()).toBe(true);
  return ((await res.json()) as { count: number }).count;
}

/** The bell of the header: an icon button whose accessible name speaks of "avisos". */
function bell(page: Page): Locator {
  return page.getByRole('banner').getByRole('button', { name: /avisos/i });
}

/** The inbox, a Sheet (dialog) opened from the bell. */
function panel(page: Page): Locator {
  return page.getByRole('dialog');
}

function items(page: Page): Locator {
  return panel(page).getByRole('listitem');
}

/** The "…" menu of a notification (a menu button). */
function moreMenu(item: Locator): Locator {
  return item.locator('[aria-haspopup="menu"]');
}

/** The part of a notification that opens it: its link, or its button that is not the "…" menu. */
function opener(item: Locator): Locator {
  return item.locator('a, button:not([aria-haspopup])').first();
}

async function openHome(page: Page): Promise<void> {
  await page.goto('/');
  await expect(bell(page)).toBeVisible();
}

async function openPanel(page: Page): Promise<void> {
  await bell(page).click();
  await expect(panel(page)).toBeVisible();
}

/** With no unread notifications, the bell shows no count above 0. */
async function expectNoUnreadBadge(page: Page): Promise<void> {
  await expect(bell(page)).not.toContainText(/[1-9]/);
}

test.describe('TASK-179 campana y bandeja de avisos', () => {
  test('RF-M15-06 la campana muestra la cantidad de avisos no leídos', async ({
    authedPage,
    testUser,
  }) => {
    for (let i = 0; i < 3; i += 1) {
      await createNotification(authedPage, testUser, {
        type: 'budget_alert',
        targetRoute: '/',
      });
    }
    const [first] = await listNotifications(authedPage);
    expect(first).toBeDefined();
    const read = await authedPage.request.post(`/api/notifications/${first?.id ?? ''}/read`);
    expect(read.status()).toBe(204);
    expect(await unreadCount(authedPage)).toBe(2);

    await openHome(authedPage);
    await expect(bell(authedPage)).toContainText('2');
  });

  test('RF-M15-06 sin avisos no leídos la campana no muestra un contador', async ({
    authedPage,
  }) => {
    await openHome(authedPage);
    await expectNoUnreadBadge(authedPage);
  });

  test('RF-M15-06 la campana pide el contador en segundo plano con X-Background', async ({
    authedPage,
  }) => {
    const request = authedPage.waitForRequest(
      (req) =>
        req.url().includes('/api/notifications/unread-count') &&
        req.headers()['x-background'] === '1',
    );
    await authedPage.goto('/');
    await request;
  });

  test('RF-M15-06 al volver a la ventana la campana muestra los avisos nuevos', async ({
    authedPage,
    testUser,
  }) => {
    await openHome(authedPage);
    await expectNoUnreadBadge(authedPage);

    await createNotification(authedPage, testUser, { type: 'budget_alert', targetRoute: '/' });
    await authedPage.evaluate(() => {
      window.dispatchEvent(new Event('visibilitychange'));
      document.dispatchEvent(new Event('visibilitychange'));
      window.dispatchEvent(new Event('focus'));
    });
    await expect(bell(authedPage)).toContainText('1', { timeout: 10_000 });
  });

  test('TASK-179 la bandeja muestra el texto de cada aviso y no su clave', async ({
    authedPage,
    testUser,
  }) => {
    await createNotification(authedPage, testUser, { type: 'budget_alert', targetRoute: '/' });
    await openHome(authedPage);
    await openPanel(authedPage);

    await expect(items(authedPage)).toHaveCount(1);
    const text = (await items(authedPage).first().innerText()).trim();
    expect(text).not.toBe('');
    expect(text).not.toContain('budget_alert');
    expect(text).not.toContain('{{');
    expect(text).not.toMatch(/notifications\./);
  });

  test('TASK-179 tocar un aviso lo marca como leído y lleva a su pantalla', async ({
    authedPage,
    testUser,
  }) => {
    await createNotification(authedPage, testUser, {
      type: 'budget_alert',
      targetRoute: '/cuentas',
    });
    await openHome(authedPage);
    await expect(bell(authedPage)).toContainText('1');
    await openPanel(authedPage);

    await opener(items(authedPage).first()).click();
    await expect(authedPage).toHaveURL(/\/cuentas$/);
    await expect
      .poll(async () => (await listNotifications(authedPage)).map((n) => n.read), {
        timeout: 10_000,
      })
      .toEqual([true]);
    await expect.poll(() => unreadCount(authedPage), { timeout: 10_000 }).toBe(0);
    await expectNoUnreadBadge(authedPage);
  });

  test('RF-M15-11 un aviso cuyo destino ya no existe muestra "Esto ya no existe" y queda leído', async ({
    authedPage,
    testUser,
  }) => {
    const targetRoute = `/deudas/${randomUUID()}`;
    await createNotification(authedPage, testUser, { type: 'payment_upcoming', targetRoute });
    await openHome(authedPage);
    await openPanel(authedPage);

    await opener(items(authedPage).first()).click();
    await expect(authedPage).toHaveURL(new RegExp(`${targetRoute}$`));
    await expect(authedPage.getByText('Esto ya no existe').first()).toBeVisible();
    await expect
      .poll(async () => (await listNotifications(authedPage)).map((n) => n.read), {
        timeout: 10_000,
      })
      .toEqual([true]);
    expect(await unreadCount(authedPage)).toBe(0);
  });

  test('RF-M15-12 "Marcar todo como leído" deja el contador en 0, también con avisos que esperan una decisión', async ({
    authedPage,
    testUser,
  }) => {
    const ref = randomUUID();
    await createNotification(authedPage, testUser, { type: 'budget_alert', targetRoute: '/' });
    await createNotification(authedPage, testUser, { type: 'payment_upcoming', targetRoute: '/' });
    await createNotification(authedPage, testUser, {
      type: 'period_close',
      targetRoute: '/',
      decision: { kind: 'budget_period', ref },
    });
    await openHome(authedPage);
    await expect(bell(authedPage)).toContainText('3');
    await openPanel(authedPage);

    await panel(authedPage).getByRole('button', { name: /marcar todo como leído/i }).click();
    await expect.poll(() => unreadCount(authedPage), { timeout: 10_000 }).toBe(0);
    const all = await listNotifications(authedPage);
    expect(all).toHaveLength(3);
    expect(all.every((n) => n.read)).toBe(true);
    // The decision stays available in its module (RF-M15-03).
    const waiting = all.find((n) => n.decision !== undefined);
    expect(waiting?.decision).toEqual({ kind: 'budget_period', ref, status: 'waiting' });

    await expectNoUnreadBadge(authedPage);
  });

  test('RF-M15-12 eliminar desde el menú "…" un aviso que espera una decisión', async ({
    authedPage,
    testUser,
  }) => {
    await createNotification(authedPage, testUser, {
      type: 'period_close',
      targetRoute: '/',
      decision: { kind: 'budget_period', ref: randomUUID() },
    });
    await openHome(authedPage);
    await expect(bell(authedPage)).toContainText('1');
    await openPanel(authedPage);
    await expect(items(authedPage)).toHaveCount(1);

    await moreMenu(items(authedPage).first()).click();
    await authedPage.getByRole('menuitem', { name: 'Eliminar' }).click();

    await expect(items(authedPage)).toHaveCount(0);
    await expect.poll(async () => (await listNotifications(authedPage)).length).toBe(0);
    expect(await unreadCount(authedPage)).toBe(0);
  });

  test('RNF-06 eliminar desde el menú "…" funciona con el teclado y sin violaciones de axe', async ({
    authedPage,
    testUser,
  }) => {
    await createNotification(authedPage, testUser, { type: 'budget_alert', targetRoute: '/' });
    await createNotification(authedPage, testUser, { type: 'payment_upcoming', targetRoute: '/' });
    await openHome(authedPage);
    await expect(bell(authedPage)).toContainText('2');
    await expectNoBlockingViolations(authedPage);

    // The bell opens the inbox with the keyboard.
    await bell(authedPage).focus();
    await expect(bell(authedPage)).toBeFocused();
    await authedPage.keyboard.press('Enter');
    await expect(panel(authedPage)).toBeVisible();
    await expect(items(authedPage)).toHaveCount(2);
    await expectNoBlockingViolations(authedPage);

    // The "…" menu is a named button reached and opened with the keyboard.
    const menu = moreMenu(items(authedPage).first());
    await expect(menu).toHaveAccessibleName(/.+/);
    await menu.focus();
    await expect(menu).toBeFocused();
    await authedPage.keyboard.press('Enter');
    const remove = authedPage.getByRole('menuitem', { name: 'Eliminar' });
    await expect(remove).toBeVisible();
    await expectNoBlockingViolations(authedPage);
    await remove.focus();
    await expect(remove).toBeFocused();
    await authedPage.keyboard.press('Enter');

    await expect(items(authedPage)).toHaveCount(1);
    await expect.poll(async () => (await listNotifications(authedPage)).length).toBe(1);
    await expect.poll(() => unreadCount(authedPage)).toBe(1);
    await expect(bell(authedPage)).toContainText('1');
  });
});
