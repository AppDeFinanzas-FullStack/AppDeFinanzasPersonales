import type { Page } from '@playwright/test';

import { expect, test } from './fixtures/auth.js';

/**
 * TASK-222: with `RELEASE=1.0` no module of V1.1 shows up in the menu, Inicio or the header
 * (RF-M2-03). These cases only run with `e2e:release-1.0` (plan §5.1).
 */

const DESKTOP_WIDTH = 1280;
const MOBILE_WIDTH = 360;
const HEIGHT = 800;

const V1_1_MODULES = [/^presupuestos$/i, /^metas de ahorro$/i, /^deudas y préstamos$/i] as const;

async function settle(page: Page): Promise<void> {
  await expect(page.getByRole('main')).toBeVisible();
  await expect(page.locator('.animate-pulse')).toHaveCount(0);
  await page.waitForLoadState('networkidle');
}

test.describe('TASK-222 entregas: V1.1 oculta con RELEASE=1.0', () => {
  test('RF-M2-03 @release-1.0 la cabecera no tiene la campana de avisos', async ({
    authedPage,
  }) => {
    await authedPage.goto('/');
    await settle(authedPage);
    await expect(authedPage.getByRole('button', { name: /avisos/i })).toHaveCount(0);
    await expect(
      authedPage.getByRole('banner').getByRole('button', { name: /avisos/i }),
    ).toHaveCount(0);
  });

  test('RF-M2-03 @release-1.0 Más no muestra PLANIFICAR ni sus módulos', async ({
    authedPage,
  }) => {
    await authedPage.goto('/mas');
    await expect(authedPage.getByText(/^organizar$/i).first()).toBeVisible();
    await expect(authedPage.getByText(/^planificar$/i)).toHaveCount(0);
    for (const name of V1_1_MODULES) {
      await expect(authedPage.getByRole('link', { name })).toHaveCount(0);
    }
  });

  test('RF-M2-03 @release-1.0 la barra lateral no ofrece módulos de V1.1', async ({
    authedPage,
  }) => {
    await authedPage.setViewportSize({ width: DESKTOP_WIDTH, height: HEIGHT });
    await authedPage.goto('/');
    await settle(authedPage);
    await expect(authedPage.getByRole('link', { name: 'Cuentas' }).first()).toBeVisible();
    await expect(authedPage.getByText(/^planificar$/i)).toHaveCount(0);
    for (const name of V1_1_MODULES) {
      await expect(authedPage.getByRole('link', { name })).toHaveCount(0);
    }
  });

  test('RF-M2-03 @release-1.0 la barra inferior no ofrece módulos de V1.1', async ({
    authedPage,
  }) => {
    await authedPage.setViewportSize({ width: MOBILE_WIDTH, height: HEIGHT });
    await authedPage.goto('/');
    await settle(authedPage);
    const nav = authedPage.getByRole('navigation').first();
    await expect(nav.getByRole('link', { name: 'Cuentas' })).toBeVisible();
    for (const name of V1_1_MODULES) {
      await expect(nav.getByRole('link', { name })).toHaveCount(0);
    }
  });

  test('RF-M2-03 @release-1.0 el Inicio no muestra los bloques de V1.1', async ({
    authedPage,
  }) => {
    await authedPage.goto('/');
    await settle(authedPage);
    await expect(authedPage.getByText('Presupuesto del mes')).toHaveCount(0);
    await expect(authedPage.getByText('Próximos pagos y deudas')).toHaveCount(0);
  });

  test('RF-M2-03 @release-1.0 Ajustes › Inicio no ofrece ordenar los bloques de V1.1', async ({
    authedPage,
  }) => {
    await authedPage.goto('/ajustes/inicio');
    await settle(authedPage);
    await expect(authedPage.getByText('Presupuesto del mes')).toHaveCount(0);
    await expect(authedPage.getByText('Próximos pagos y deudas')).toHaveCount(0);
  });
});
