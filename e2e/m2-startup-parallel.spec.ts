import { randomUUID } from 'node:crypto';

import type { Page, Route } from '@playwright/test';

import { expect, test } from './fixtures/auth.js';
import { expectNoBlockingViolations } from './support/axe.js';

/**
 * TASK-258: the Inicio asks for its data at the same time as the session, and shows a skeleton
 * (never a blank screen) while the data arrives. The checks compare the ORDER of events, not
 * milliseconds, so they hold on a slow computer: `/api/me` is held until the page has asked
 * for the dashboard (or a generous limit passes).
 */

const BOLIVIA_OFFSET_MS = 4 * 60 * 60 * 1000;
/** The longest `/api/me` is held waiting for the dashboard request before giving up. */
const HOLD_LIMIT_MS = 15_000;
/** A zone whose month, near the start of a month, is not the month of Bolivia. */
const OTHER_TIME_ZONE = 'Pacific/Auckland';
const LOADING = /cargando/i;

const pad = (n: number): string => String(n).padStart(2, '0');

interface Me {
  timezone: string;
}

/** A gate that opens once, from outside. */
function gate(): { opened: Promise<void>; open: () => void } {
  let open!: () => void;
  const opened = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { opened, open };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function previousMonthStart(): string {
  const now = new Date(Date.now() - BOLIVIA_OFFSET_MS);
  const index = now.getUTCFullYear() * 12 + now.getUTCMonth() - 1;
  return `${Math.floor(index / 12)}-${pad((index % 12) + 1)}-01`;
}

/** The first account, so the Inicio shows its blocks instead of the first account form. */
async function createAccount(page: Page): Promise<void> {
  const res = await page.request.post('/api/accounts', {
    data: {
      id: randomUUID(),
      type: 'cash',
      name: 'Efectivo',
      currencyCode: 'BOB',
      initialBalance: '100',
      initialBalanceDate: previousMonthStart(),
      color: 'teal',
      icon: 'wallet',
    },
  });
  expect(res.status()).toBe(201);
}

async function readMe(page: Page): Promise<Me> {
  const res = await page.request.get('/api/me');
  expect(res.status()).toBe(200);
  return (await res.json()) as Me;
}

/** The month `YYYY-MM` that `instant` falls in, in `timeZone`. */
function monthIn(timeZone: string, instant: Date): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
  }).formatToParts(instant);
  const part = (type: string): string => parts.find((p) => p.type === type)?.value ?? '';
  return `${part('year')}-${part('month')}`;
}

/** "Octubre de 2026", as the month selector writes it. */
function monthLabel(month: string): string {
  const [year = 1970, index = 1] = month.split('-').map(Number);
  const text = new Intl.DateTimeFormat('es-BO', {
    month: 'long',
    year: 'numeric',
    timeZone: 'UTC',
  }).format(new Date(Date.UTC(year, index - 1, 1)));
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/** The Inicio is drawn once its cards navigation shows up. */
const inicioReady = (page: Page) =>
  page.getByRole('navigation', { name: 'Ver movimientos del mes' });

/**
 * Remembers whether the figures of the Inicio were ever drawn in a page, even for a moment
 * (read it back with `sawData`).
 */
async function watchForData(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const check = (): void => {
      if (/tasa de ahorro/i.test(document.documentElement.innerText)) {
        (window as unknown as { sawData?: boolean }).sawData = true;
      }
    };
    new MutationObserver(check).observe(document, { subtree: true, childList: true });
  });
}

async function sawData(page: Page): Promise<boolean> {
  return page.evaluate(() => (window as unknown as { sawData?: boolean }).sawData ?? false);
}

/** Months asked of `/api/dashboard`, in order. */
function trackDashboardMonths(page: Page): string[] {
  const months: string[] = [];
  page.on('request', (request) => {
    const url = new URL(request.url());
    if (url.pathname === '/api/dashboard') months.push(url.searchParams.get('month') ?? '');
  });
  return months;
}

test.describe('TASK-258 arranque en paralelo y esqueletos', () => {
  test('RNF-03 con una pista guardada, /api/dashboard sale antes de que /api/me responda', async ({
    authedPage,
  }) => {
    await createAccount(authedPage);
    // The sign-in just made a successful /api/me, which left the hint of this device.
    const events: string[] = [];
    const dashboardAsked = gate();
    authedPage.on('request', (request) => {
      if (new URL(request.url()).pathname === '/api/dashboard') {
        events.push('dashboard:request');
        dashboardAsked.open();
      }
    });
    await authedPage.route('**/api/me', async (route: Route) => {
      events.push('me:request');
      // Delays the answer until the dashboard was asked for: the order is what counts.
      await Promise.race([dashboardAsked.opened, sleep(HOLD_LIMIT_MS)]);
      events.push('me:answer');
      await route.continue();
    });

    await authedPage.goto('/');

    await expect(inicioReady(authedPage)).toBeVisible();
    expect(events).toContain('dashboard:request');
    expect(events).toContain('me:answer');
    expect(events.indexOf('dashboard:request')).toBeLessThan(events.indexOf('me:answer'));
  });

  test('RNF-03 con una pista de otra zona horaria, el Inicio termina con el mes de la zona real', async ({
    authedPage,
  }) => {
    await createAccount(authedPage);
    const { timezone } = await readMe(authedPage);

    // At 02:00 UTC on the 1st it is still the previous month in Bolivia and already the new one
    // in Auckland, so the two zones disagree on the month.
    const now = new Date();
    const boundary = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1, 2, 0, 0));
    const realMonth = monthIn(timezone, boundary);
    const hintedMonth = monthIn(OTHER_TIME_ZONE, boundary);
    expect(hintedMonth).not.toBe(realMonth);
    await authedPage.clock.setFixedTime(boundary);

    // A load where /api/me claims another zone leaves that zone as the hint of this device.
    await authedPage.route('**/api/me', async (route) => {
      const response = await route.fetch();
      const body = (await response.json()) as Me;
      await route.fulfill({ response, json: { ...body, timezone: OTHER_TIME_ZONE } });
    });
    await authedPage.goto('/');
    await expect(inicioReady(authedPage)).toBeVisible();
    await authedPage.unroute('**/api/me');

    // Now the real /api/me disagrees with the hint.
    const months = trackDashboardMonths(authedPage);
    await authedPage.goto('/');

    await expect(inicioReady(authedPage)).toBeVisible();
    await expect(authedPage.getByText(monthLabel(realMonth), { exact: true })).toBeVisible();
    expect(months).toContain(realMonth);
    expect(months.at(-1)).toBe(realMonth);
  });

  test('RF-M1-04 sin sesión, / va a /entrar y no muestra datos ni esqueleto de datos', async ({
    page,
  }) => {
    const months = trackDashboardMonths(page);
    await watchForData(page);

    await page.goto('/');

    await expect(page).toHaveURL(/\/entrar/);
    await expect(page.getByRole('status', { name: LOADING })).toHaveCount(0);
    expect(months).toEqual([]);
    expect(await sawData(page)).toBe(false);
  });

  test('RF-M1-04 con la sesión vencida y una pista guardada, / va a /entrar sin mostrar datos y la pista se borra', async ({
    authedPage,
  }) => {
    await createAccount(authedPage);
    const { timezone } = await readMe(authedPage);
    await watchForData(authedPage);

    await authedPage.context().clearCookies();
    await authedPage.goto('/');

    await expect(authedPage).toHaveURL(/\/entrar/);
    expect(await sawData(authedPage)).toBe(false);
    // The 401 erased the hint: nothing kept in localStorage still names the zone of the user.
    const kept = await authedPage.evaluate(() =>
      Object.keys(localStorage).map((key) => localStorage.getItem(key) ?? ''),
    );
    expect(kept.filter((value) => value.includes(timezone))).toEqual([]);
  });

  test('RNF-06 mientras llega /api/me el esqueleto se anuncia como "Cargando" y axe no reporta violaciones serias', async ({
    authedPage,
  }) => {
    const release = gate();
    await authedPage.route('**/api/me', async (route) => {
      await Promise.race([release.opened, sleep(HOLD_LIMIT_MS)]);
      await route.continue();
    });

    await authedPage.goto('/');

    const skeleton = authedPage.getByRole('status', { name: LOADING });
    await expect(skeleton.first()).toBeVisible();
    await expectNoBlockingViolations(authedPage);

    release.open();
    await expect(skeleton).toHaveCount(0);
    await expect(authedPage).not.toHaveURL(/\/entrar/);
  });

  test('RNF-06 mientras llegan las cuentas el Inicio muestra un esqueleto anunciado como "Cargando" y axe no reporta violaciones serias', async ({
    authedPage,
  }) => {
    await createAccount(authedPage);
    const release = gate();
    await authedPage.route(/\/api\/accounts\?status=active/, async (route) => {
      await Promise.race([release.opened, sleep(HOLD_LIMIT_MS)]);
      await route.continue();
    });

    await authedPage.goto('/');

    const skeleton = authedPage.getByRole('status', { name: LOADING });
    await expect(skeleton.first()).toBeVisible();
    await expectNoBlockingViolations(authedPage);

    release.open();
    await expect(inicioReady(authedPage)).toBeVisible();
    await expect(skeleton).toHaveCount(0);
  });
});
