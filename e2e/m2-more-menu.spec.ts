import { expect, test } from './fixtures/auth.js';

const MOBILE_WIDTH = 360;
const HEIGHT = 800;
const SCROLL_TARGET = 400;
const SCROLL_TOLERANCE = 20;

test.describe('TASK-073 menú Más, memoria por pestaña y botón Atrás', () => {
  test.beforeEach(async ({ authedPage }) => {
    await authedPage.setViewportSize({ width: MOBILE_WIDTH, height: HEIGHT });
  });

  test('RF-M2-12 @release-1.0 con RELEASE=1.0 PLANIFICAR no aparece en Más', async ({
    authedPage,
  }) => {
    await authedPage.goto('/mas');
    await expect(authedPage.getByText(/^organizar$/i)).toBeVisible();
    await expect(authedPage.getByText(/^cuenta$/i)).toBeVisible();
    await expect(authedPage.getByText(/^planificar$/i)).toHaveCount(0);
  });

  test('RF-M2-12 Más muestra ORGANIZAR y CUENTA con sus módulos', async ({ authedPage }) => {
    await authedPage.goto('/mas');
    await expect(authedPage.getByText(/^organizar$/i)).toBeVisible();
    await expect(authedPage.getByRole('link', { name: 'Categorías' })).toBeVisible();
    await expect(authedPage.getByText(/^cuenta$/i)).toBeVisible();
    await expect(authedPage.getByRole('link', { name: 'Perfil' })).toBeVisible();
  });

  test('RF-M2-04 al cambiar de pestaña y volver se restauran la URL y la posición', async ({
    authedPage,
  }) => {
    const nav = authedPage.getByRole('navigation').first();
    await authedPage.goto('/movimientos?mes=2026-01');
    await authedPage.addStyleTag({ content: 'body { min-height: 3000px; }' });
    await authedPage.evaluate((y) => window.scrollTo(0, y), SCROLL_TARGET);
    await expect.poll(() => authedPage.evaluate(() => window.scrollY)).toBeGreaterThan(0);
    const savedY = await authedPage.evaluate(() => window.scrollY);

    await nav.getByRole('link', { name: 'Cuentas' }).click();
    await expect(authedPage).toHaveURL(/\/cuentas/);
    await nav.getByRole('link', { name: 'Movimientos' }).click();

    await expect(authedPage).toHaveURL(/\/movimientos\?mes=2026-01/);
    await expect
      .poll(() => authedPage.evaluate(() => window.scrollY))
      .toBeGreaterThanOrEqual(savedY - SCROLL_TOLERANCE);
  });

  test('RF-M2-05 tocar la pestaña activa lleva a la raíz del módulo', async ({ authedPage }) => {
    const nav = authedPage.getByRole('navigation').first();
    await authedPage.goto('/movimientos?mes=2026-01');
    await nav.getByRole('link', { name: 'Movimientos' }).click();
    await expect(authedPage).toHaveURL(/\/movimientos$/);
  });

  test('RF-M2-05 Más recuerda el último módulo abierto desde ella', async ({ authedPage }) => {
    const nav = authedPage.getByRole('navigation').first();
    await authedPage.goto('/mas');
    await authedPage.getByRole('link', { name: 'Categorías' }).click();
    await expect(authedPage).toHaveURL(/\/categorias/);

    await nav.getByRole('link', { name: 'Cuentas' }).click();
    await expect(authedPage).toHaveURL(/\/cuentas/);

    await nav.getByRole('link', { name: 'Más', exact: true }).click();
    await expect(authedPage).toHaveURL(/\/categorias/);
  });

  test('RF-M2-06 el botón Atrás vuelve a la pantalla anterior', async ({ authedPage }) => {
    await authedPage.goto('/mas');
    await authedPage.getByRole('link', { name: 'Categorías' }).click();
    await expect(authedPage).toHaveURL(/\/categorias/);

    await authedPage.goBack();
    await expect(authedPage).toHaveURL(/\/mas/);
    await expect(authedPage.getByRole('navigation').first()).toBeVisible();
  });
});
