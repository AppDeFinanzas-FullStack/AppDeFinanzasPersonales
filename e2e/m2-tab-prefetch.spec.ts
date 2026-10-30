import type { Locator, Page, Route } from '@playwright/test';

import { expect, test } from './fixtures/auth.js';

/**
 * TASK-259: each tab asks for its main data as soon as it is chosen, instead of after its screen
 * downloaded and mounted. The checks compare the ORDER of events, not milliseconds, so they hold on
 * a slow computer: a download is held until the page has asked for the data (or a generous limit
 * passes).
 */

/** The longest a request is held waiting for the event it should come before, before giving up. */
const HOLD_LIMIT_MS = 15_000;
const SCROLL_Y = 600;
const SCROLL_TOLERANCE_PX = 2;
const REMEMBERED_MONTH = '2020-01';
const REMEMBERED_MONTH_LABEL = 'Enero de 2020';
const NOT_FOUND = 'Esto ya no existe.';

/** The list of the movements, not its summary: `/api/transactions` and nothing under it. */
const TRANSACTIONS_PATH = '/api/transactions';
const TRANSACTIONS_URL = /\/api\/transactions(\?|$)/;
/** The endpoints of the modules that arrive after V1.0 (their paths, without any id below them). */
const GATED_PATHS = ['/api/budgets', '/api/goals', '/api/debts', '/api/recurring'] as const;
const GATED_SCREENS = ['/presupuestos', '/metas', '/deudas', '/recurrentes'] as const;

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

/** A link of the navigation that is on screen: the bottom bar below 1024 px, the sidebar above. */
function tab(page: Page, name: string): Locator {
  return page.getByRole('navigation').first().getByRole('link', { name, exact: true });
}

/** The Inicio is drawn and the network is quiet: the next requests are the ones under test. */
async function settle(page: Page): Promise<void> {
  await expect(page.getByRole('main')).toBeVisible();
  await expect(page.locator('.animate-pulse')).toHaveCount(0);
  await page.waitForLoadState('networkidle');
}

/** Counts the requests to `path` (exactly, so `/api/transactions/summary` does not count). */
function countRequestsTo(page: Page, paths: readonly string[]): { count: () => number } {
  let total = 0;
  page.on('request', (request) => {
    if (paths.includes(new URL(request.url()).pathname)) total += 1;
  });
  return { count: () => total };
}

/** The profile of the user with the release that the app should believe it is running. */
async function reportRelease(page: Page, release: '1.0' | '1.1' | '1.2'): Promise<void> {
  await page.route('**/api/me', async (route: Route) => {
    if (route.request().method() !== 'GET') {
      await route.fallback();
      return;
    }
    try {
      const response = await route.fetch();
      const body = (await response.json()) as Record<string, unknown>;
      await route.fulfill({ response, json: { ...body, release } });
    } catch {
      // The page was closed or navigated away while the request was in flight: nothing to answer.
      await route.abort().catch(() => undefined);
    }
  });
}

/**
 * The API fails the list of the movements (not its summary): every time, or only the first
 * `times` ones, then it answers as usual.
 */
async function failTransactions(page: Page, times = Number.POSITIVE_INFINITY): Promise<void> {
  let failed = 0;
  await page.route(TRANSACTIONS_URL, async (route: Route) => {
    if (failed >= times) {
      await route.continue();
      return;
    }
    failed += 1;
    await route.fulfill({
      status: 500,
      contentType: 'application/problem+json',
      json: {
        type: 'https://errors.app/INTERNAL_ERROR',
        title: 'INTERNAL_ERROR',
        status: 500,
        code: 'INTERNAL_ERROR',
        traceId: 'e2e-prefetch',
      },
    });
  });
}

test.describe('TASK-259 precarga de los datos de cada pestaña', () => {
  test('RNF-29 al abrir Movimientos por primera vez, sus datos se piden sin esperar el código de la pantalla', async ({
    authedPage,
  }) => {
    await authedPage.goto('/');
    await settle(authedPage);

    // From here on, the code of any screen not yet downloaded is held until the page has asked for
    // the movements. Only the code of the route and the data it asks for are left to arrive.
    const events: string[] = [];
    const dataAsked = gate();
    authedPage.on('request', (request) => {
      if (new URL(request.url()).pathname === TRANSACTIONS_PATH) {
        events.push('data:request');
        dataAsked.open();
      }
    });
    await authedPage.route(/\/assets\/.+\.js(\?.*)?$/, async (route: Route) => {
      events.push('code:request');
      await Promise.race([dataAsked.opened, sleep(HOLD_LIMIT_MS)]);
      events.push('code:released');
      await route.continue();
    });

    // A click without a pointer passing over the tab: only the loader of the route can ask.
    await tab(authedPage, 'Movimientos').dispatchEvent('click');

    await expect(authedPage.getByRole('button', { name: 'Mes anterior' })).toBeVisible();
    expect(events).toContain('code:request');
    expect(events).toContain('data:request');
    expect(events).toContain('code:released');
    expect(events.indexOf('data:request')).toBeLessThan(events.indexOf('code:released'));
  });

  test('RNF-29 apuntar con el ratón a la pestaña ya pide sus datos y apuntar de nuevo antes de 10 s no repite la petición', async ({
    authedPage,
  }) => {
    await authedPage.goto('/');
    await settle(authedPage);
    const asked = countRequestsTo(authedPage, [TRANSACTIONS_PATH]);
    const link = tab(authedPage, 'Movimientos');

    await link.hover();
    await expect.poll(asked.count).toBe(1);

    // Away from the tab and back to it.
    await authedPage.mouse.move(0, 0);
    await link.hover();
    await authedPage.waitForLoadState('networkidle');

    expect(asked.count()).toBe(1);
  });

  test('RNF-29 el foco del teclado en la pestaña también pide sus datos, sin repetir con el ratón', async ({
    authedPage,
  }) => {
    await authedPage.goto('/');
    await settle(authedPage);
    const asked = countRequestsTo(authedPage, [TRANSACTIONS_PATH]);
    const link = tab(authedPage, 'Movimientos');

    await link.focus();
    await expect.poll(asked.count).toBe(1);

    await link.blur();
    await link.hover();
    await authedPage.waitForLoadState('networkidle');

    expect(asked.count()).toBe(1);
  });

  test('RNF-29 aunque la primera petición falle, apuntar y enfocar la misma pestaña antes de 10 s no la repite', async ({
    authedPage,
  }) => {
    await authedPage.goto('/');
    await settle(authedPage);
    await failTransactions(authedPage);
    const asked = countRequestsTo(authedPage, [TRANSACTIONS_PATH]);
    const link = tab(authedPage, 'Movimientos');

    await link.hover();
    await expect.poll(asked.count).toBe(1);

    await authedPage.mouse.move(0, 0);
    await link.focus();
    await link.blur();
    await link.hover();
    await authedPage.waitForLoadState('networkidle');

    expect(asked.count()).toBe(1);
    // The failure of the prefetch shows nothing.
    await expect(authedPage.getByRole('alert')).toHaveCount(0);
  });

  test('RF-M2-03 con RELEASE=1.0 apuntar o abrir Metas, Deudas, Presupuestos o Recurrentes no dispara ninguna petición', async ({
    authedPage,
  }) => {
    await reportRelease(authedPage, '1.0');
    const asked = countRequestsTo(authedPage, GATED_PATHS);

    await authedPage.goto('/');
    await settle(authedPage);
    const links = authedPage.getByRole('navigation').first().getByRole('link');
    const total = await links.count();
    for (let index = 0; index < total; index += 1) {
      await links.nth(index).hover();
      await links.nth(index).focus();
    }
    for (const path of GATED_SCREENS) {
      await authedPage.goto(path);
      await expect(authedPage.getByRole('heading', { name: NOT_FOUND }), path).toBeVisible();
    }
    await authedPage.waitForLoadState('networkidle');

    expect(asked.count()).toBe(0);
  });

  test('RF-M2-03 con RELEASE=1.1 abrir Recurrentes no dispara ninguna petición', async ({
    authedPage,
  }) => {
    await reportRelease(authedPage, '1.1');
    const asked = countRequestsTo(authedPage, ['/api/recurring']);

    await authedPage.goto('/recurrentes');
    await expect(authedPage.getByRole('heading', { name: NOT_FOUND })).toBeVisible();
    await authedPage.waitForLoadState('networkidle');

    expect(asked.count()).toBe(0);
  });

  test('RF-M2-04 la pestaña sigue restaurando su URL y su posición al volver a ella', async ({
    authedPage,
  }) => {
    await authedPage.goto(`/movimientos?mes=${REMEMBERED_MONTH}`);
    await expect(authedPage.getByText(REMEMBERED_MONTH_LABEL, { exact: true })).toBeVisible();
    // A tall page, so there is a position to remember even without movements.
    await authedPage.evaluate((y) => {
      document.body.style.minHeight = '4000px';
      window.scrollTo(0, y);
    }, SCROLL_Y);
    await expect
      .poll(() => authedPage.evaluate(() => window.scrollY))
      .toBeGreaterThanOrEqual(SCROLL_Y - SCROLL_TOLERANCE_PX);

    // The tabs are activated without scrolling them into view: on a wide screen the sidebar of a
    // page made taller by this test would be scrolled away, and Playwright would move the page.
    await tab(authedPage, 'Cuentas').dispatchEvent('click');
    await expect(authedPage).toHaveURL(/\/cuentas/);
    await tab(authedPage, 'Movimientos').dispatchEvent('click');

    await expect(authedPage).toHaveURL(new RegExp(`/movimientos\\?mes=${REMEMBERED_MONTH}`));
    await expect(authedPage.getByText(REMEMBERED_MONTH_LABEL, { exact: true })).toBeVisible();
    await expect
      .poll(async () => Math.abs((await authedPage.evaluate(() => window.scrollY)) - SCROLL_Y))
      .toBeLessThanOrEqual(SCROLL_TOLERANCE_PX);
  });

  test('TASK-259 un error del prefetch no muestra nada y la pantalla repite la petición al montarse', async ({
    authedPage,
  }) => {
    await authedPage.goto('/');
    await settle(authedPage);
    await failTransactions(authedPage, 1);
    const asked = countRequestsTo(authedPage, [TRANSACTIONS_PATH]);

    // Only the loader asks first; its request fails, and the screen asks again when it mounts.
    await tab(authedPage, 'Movimientos').dispatchEvent('click');

    await expect(authedPage.getByText(/no hay movimientos con estos filtros/i)).toBeVisible();
    expect(asked.count()).toBeGreaterThanOrEqual(2);
    await expect(authedPage.getByRole('alert')).toHaveCount(0);
  });
});
