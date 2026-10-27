import { execSync } from 'node:child_process';

import { expect, test, type Page } from '@playwright/test';

import { collectScriptBytes, throttle } from './support/network-profiles.js';

/** The performance user of the seed (TASK-166): 5.000 movements over 12 months. */
const PERF_EMAIL = 'rendimiento@e2e.test';
const PERF_PASSWORD = 'Prueba-E2E-2026';

/** RNF-01: registering takes less than 10 s from opening the app. */
const REGISTER_BUDGET_MS = 10_000;
/** RNF-03: the Inicio loads in less than 2 s with 5.000 movements. */
const HOME_BUDGET_MS = 2_000;
/** Plan §5.3: the `/registrar` route weighs at most 300 KB of gzipped JavaScript. */
const REGISTER_JS_BUDGET_BYTES = 300 * 1024;

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

test.describe('TASK-168 rendimiento E2E', () => {
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

  test('RNF-01 registrar un gasto tarda menos de 10 s desde abrir la app hasta guardar, en 4G y con CPU x4', async ({
    page,
  }) => {
    test.setTimeout(60_000);
    await signInAsPerfUser(page);
    await throttle(page);

    const started = Date.now();
    await page.goto('/registrar');
    await page.getByLabel('Monto').fill('35');
    await page
      .getByRole('group', { name: 'Categoría' })
      .locator('button[aria-pressed]')
      .first()
      .click();
    await page.getByRole('button', { name: 'Guardar', exact: true }).click();
    await expect(page.getByText(/guardado/i).first()).toBeVisible({ timeout: REGISTER_BUDGET_MS });
    const elapsed = Date.now() - started;

    test.info().annotations.push({ type: 'tiempo', description: `${String(elapsed)} ms` });
    expect(elapsed, 'milisegundos para registrar').toBeLessThan(REGISTER_BUDGET_MS);
  });

  test('RNF-03 el Inicio con 5.000 movimientos carga en menos de 2 s, en 4G y con CPU x4', async ({
    page,
  }) => {
    test.setTimeout(60_000);
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

  test('RNF-01 el JavaScript que descarga /registrar pesa 300 KB gzip o menos', async ({
    page,
  }) => {
    test.setTimeout(60_000);
    await signInAsPerfUser(page);
    // A first visit: with the cache on, the files of the sign-in would not be downloaded again.
    const session = await page.context().newCDPSession(page);
    await session.send('Network.enable');
    await session.send('Network.setCacheDisabled', { cacheDisabled: true });

    const scripts = collectScriptBytes(page);
    await page.goto('/registrar');
    await expect(page.getByLabel('Monto')).toBeVisible();
    await page.waitForLoadState('networkidle');
    const { total, files } = await scripts.stop();

    test.info().annotations.push({ type: 'js-gzip', description: `${String(total)} bytes` });
    expect(Object.keys(files).length, 'archivos JavaScript descargados').toBeGreaterThan(0);
    expect(total, `bytes gzip de JavaScript: ${JSON.stringify(files)}`).toBeLessThanOrEqual(
      REGISTER_JS_BUDGET_BYTES,
    );
  });
});
