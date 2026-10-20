import { expect, test } from './fixtures/auth.js';

const NOT_FOUND = 'Esto ya no existe.';

test.describe('TASK-071 guardas de rutas', () => {
  test('RF-M1-04 sin sesión, una ruta privada lleva a /entrar', async ({ page }) => {
    await page.goto('/perfil');
    await expect(page).toHaveURL(/\/entrar/);
  });

  test('RF-M1-04 sin sesión, la raíz tampoco abre datos y lleva a /entrar', async ({ page }) => {
    await page.goto('/');
    await expect(page).toHaveURL(/\/entrar/);
  });

  test('RF-M2-03 @release-1.0 /presupuestos muestra la página 404 con RELEASE=1.0', async ({
    authedPage,
  }) => {
    await authedPage.goto('/presupuestos');
    await expect(authedPage.getByText(NOT_FOUND)).toBeVisible();
    await expect(authedPage).toHaveURL(/\/presupuestos/);
  });
});
