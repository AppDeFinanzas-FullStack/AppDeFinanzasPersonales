import { execSync } from 'node:child_process';

import { expect, test, type Locator, type Page } from '@playwright/test';

import { throttle } from './support/network-profiles.js';

/** The performance user of the seed (TASK-166): 5.000 movements over 12 months. */
const PERF_EMAIL = 'rendimiento@e2e.test';
const PERF_PASSWORD = 'Prueba-E2E-2026';

/** RNF-29: a tab shows its main data in less than 2 s in 4G; RNF-03 does the same for the Inicio. */
const TAB_BUDGET_MS = 2_000;
const HOME_BUDGET_MS = 2_000;
const TEST_TIMEOUT_MS = 60_000;

const DATABASE_URL =
  process.env['TEST_DATABASE_URL'] ?? 'postgresql://postgres:postgres@localhost:5432/finanzas_test';

// Timings are only comparable when nothing else runs next to them inside this file.
test.describe.configure({ mode: 'serial' });

/** Signs in as the performance user without any throttling, so the session is ready. */
async function signInAsPerfUser(page: Page): Promise<void> {
  await page.goto('/entrar');
  await page.getByLabel(/correo/i).fill(PERF_EMAIL);
  await page.getByLabel(/contraseña/i).fill(PERF_PASSWORD);
  await page.getByRole('button', { name: /entrar|iniciar sesión/i }).click();
  await expect(page).not.toHaveURL(/\/entrar/);
}

/** The Inicio is drawn and the network is quiet, so only the tab under test is left to load. */
async function settle(page: Page): Promise<void> {
  await expect(page.getByRole('main')).toBeVisible();
  await expect(page.locator('.animate-pulse')).toHaveCount(0);
  await page.waitForLoadState('networkidle');
}

/** Below this width the navigation is a bottom bar of five tabs; from it on, a full sidebar. */
const SIDEBAR_MIN_WIDTH = 1024;

/**
 * The link of a tab. On a wide screen every tab is in the sidebar; on a narrow one only five are in
 * the bottom bar and the others live in the "Más" menu, which is opened here (untimed) so the timed
 * tap is the one on the tab itself. The modules of V1.1+ appear when the profile has loaded, so the
 * link is waited for instead of counted.
 */
async function tabLink(page: Page, name: string): Promise<Locator> {
  const nav = page.getByRole('navigation').first();
  const direct = nav.getByRole('link', { name, exact: true });
  const wide = (page.viewportSize()?.width ?? 0) >= SIDEBAR_MIN_WIDTH;
  if (wide) {
    await expect(direct).toBeVisible();
    return direct;
  }
  if ((await direct.count()) > 0) return direct;
  await nav.getByRole('link', { name: 'Más', exact: true }).click();
  const inMenu = page.getByRole('main').getByRole('link', { name, exact: true });
  await expect(inMenu).toBeVisible();
  return inMenu;
}

/** The main content of each tab: what its data draws, not the title the shell shows at once. */
const TABS: { name: string; link?: string; main: (page: Page) => Locator }[] = [
  {
    name: 'Movimientos',
    main: (page) =>
      page
        .getByRole('main')
        .locator('a[href^="/movimientos/"]')
        .first()
        .or(page.getByText(/no hay movimientos con estos filtros/i)),
  },
  { name: 'Cuentas', main: (page) => page.getByText('Total neto', { exact: true }) },
  {
    name: 'Presupuestos',
    main: (page) => page.getByRole('heading', { level: 2, name: 'Presupuestos', exact: true }),
  },
  {
    name: 'Metas',
    link: 'Metas de ahorro',
    main: (page) => page.getByRole('heading', { level: 2, name: 'Metas de ahorro', exact: true }),
  },
  {
    name: 'Deudas',
    link: 'Deudas y préstamos',
    main: (page) =>
      page.getByRole('heading', { level: 2, name: 'Deudas y préstamos', exact: true }),
  },
  {
    name: 'Recurrentes',
    main: (page) => page.getByRole('heading', { level: 2, name: 'Recurrentes', exact: true }),
  },
  { name: 'Categorías', main: (page) => page.getByRole('link', { name: 'Nueva categoría' }) },
  {
    name: 'Tipo de cambio',
    main: (page) => page.getByRole('heading', { level: 2, name: 'Tasas del dólar', exact: true }),
  },
];

test.describe('TASK-261 tiempo de cada pestaña', () => {
  test.beforeAll(() => {
    // The seed is idempotent: it creates the users, the rates and the 5.000 movements once.
    execSync('pnpm --filter @finanzas/db seed:e2e', {
      env: {
        ...process.env,
        NODE_ENV: 'test',
        DATABASE_URL,
        DATABASE_URL_DIRECT: DATABASE_URL,
      },
      stdio: 'pipe',
      timeout: 120_000,
    });
  });

  test.beforeEach(({ browserName }, testInfo) => {
    // Throttling the network and the CPU needs the DevTools Protocol, which only Chromium has.
    testInfo.skip(browserName !== 'chromium', 'Network and CPU throttling is Chromium-only');
  });

  for (const { name, link: linkName = name, main } of TABS) {
    test(`RNF-29 ${name} muestra su contenido en menos de 2 s en 4G y con CPU x4`, async ({
      page,
    }) => {
      test.setTimeout(TEST_TIMEOUT_MS);
      // The session is already open and the Inicio is drawn: only the tab is under test.
      await signInAsPerfUser(page);
      await settle(page);
      const link = await tabLink(page, linkName);
      await link.waitFor({ state: 'visible' });
      await throttle(page);

      const started = Date.now();
      await link.click();
      await expect(main(page).first()).toBeVisible({ timeout: TAB_BUDGET_MS });
      const elapsed = Date.now() - started;

      test.info().annotations.push({ type: 'tiempo', description: `${String(elapsed)} ms` });
      expect(elapsed, `milisegundos para mostrar ${name}`).toBeLessThan(TAB_BUDGET_MS);
    });
  }

  test('RNF-03 el Inicio con 5.000 movimientos sigue por debajo de 2 s, en 4G y con CPU x4', async ({
    page,
  }) => {
    test.setTimeout(TEST_TIMEOUT_MS);
    await signInAsPerfUser(page);
    await throttle(page);

    const started = Date.now();
    await page.goto('/');
    await expect(page.getByText('Gastos', { exact: true }).first()).toBeVisible({
      timeout: HOME_BUDGET_MS,
    });
    const elapsed = Date.now() - started;

    test.info().annotations.push({ type: 'tiempo', description: `${String(elapsed)} ms` });
    expect(elapsed, 'milisegundos para cargar el Inicio').toBeLessThan(HOME_BUDGET_MS);
  });
});
