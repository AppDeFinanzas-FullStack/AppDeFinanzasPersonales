import { expect, test } from './fixtures/auth.js';

const MOBILE_WIDTH = 360;
const DESKTOP_WIDTH = 1280;
const HEIGHT = 800;

const TAB_ORDER = ['Inicio', 'Movimientos', 'Registrar', 'Cuentas', 'Más'];

test.describe('TASK-072 AppShell, barra inferior y barra lateral', () => {
  test('RF-M2-01 RF-M7-01 Registrar en el centro de la barra en el celular', async ({
    authedPage,
  }) => {
    await authedPage.setViewportSize({ width: MOBILE_WIDTH, height: HEIGHT });
    await authedPage.goto('/');
    const nav = authedPage.getByRole('navigation').first();
    await expect(nav).toBeVisible();
    const links = nav.getByRole('link');
    await expect(links).toHaveCount(5);
    const names = (await links.allTextContents()).map((t) => t.trim());
    expect(names).toEqual(TAB_ORDER);
    expect(names[2]).toBe('Registrar');
  });

  test('RF-M2-01 en celular la barra lateral no se ve', async ({ authedPage }) => {
    await authedPage.setViewportSize({ width: MOBILE_WIDTH, height: HEIGHT });
    await authedPage.goto('/');
    await expect(authedPage.getByRole('navigation')).toHaveCount(1);
    await expect(authedPage.getByRole('button', { name: /contraer/i })).toHaveCount(0);
  });

  test('RF-M2-02 RF-M2-01 RF-M7-01 Sin "Más" en escritorio', async ({ authedPage }) => {
    await authedPage.setViewportSize({ width: DESKTOP_WIDTH, height: HEIGHT });
    await authedPage.goto('/');
    const nav = authedPage.getByRole('navigation').first();
    await expect(nav).toBeVisible();
    for (const name of ['Inicio', 'Movimientos', 'Registrar', 'Cuentas']) {
      await expect(nav.getByRole('link', { name })).toBeVisible();
    }
    await expect(authedPage.getByRole('link', { name: 'Más', exact: true })).toHaveCount(0);
    await expect(authedPage.getByText('Más', { exact: true })).toHaveCount(0);
  });

  test('RF-M2-03 @release-1.0 la navegación no ofrece módulos de entregas no liberadas', async ({
    authedPage,
  }) => {
    await authedPage.setViewportSize({ width: DESKTOP_WIDTH, height: HEIGHT });
    await authedPage.goto('/');
    const nav = authedPage.getByRole('navigation').first();
    await expect(nav.getByRole('link', { name: 'Cuentas' })).toBeVisible();
    await expect(nav.getByRole('link', { name: 'Presupuestos' })).toHaveCount(0);
  });

  test('RF-M2-09 contraer la barra en un contexto se refleja en otro contexto del mismo usuario', async ({
    authedPage,
    testUser,
    browser,
  }) => {
    await authedPage.setViewportSize({ width: DESKTOP_WIDTH, height: HEIGHT });
    await authedPage.goto('/');
    await authedPage.getByRole('button', { name: /contraer/i }).click();
    await expect(authedPage.getByRole('button', { name: /expandir/i })).toBeVisible();

    const other = await browser.newContext({ viewport: { width: DESKTOP_WIDTH, height: HEIGHT } });
    try {
      const page = await other.newPage();
      await page.goto('/entrar');
      await page.getByLabel(/correo/i).fill(testUser.email);
      await page.getByLabel(/contraseña/i).fill(testUser.password);
      await page.getByRole('button', { name: /entrar|iniciar sesión/i }).click();
      await expect(page).not.toHaveURL(/\/entrar/);
      await expect(page.getByRole('button', { name: /expandir/i })).toBeVisible();
    } finally {
      await other.close();
    }
  });

  test('EC-M2-03 cambiar el tamaño de 360 a 1280 px no pierde el estado', async ({
    authedPage,
  }) => {
    await authedPage.setViewportSize({ width: MOBILE_WIDTH, height: HEIGHT });
    await authedPage.goto('/');
    await authedPage.getByRole('navigation').first().getByRole('link', { name: 'Cuentas' }).click();
    await expect(authedPage).toHaveURL(/\/cuentas/);

    await authedPage.setViewportSize({ width: DESKTOP_WIDTH, height: HEIGHT });
    await expect(authedPage).toHaveURL(/\/cuentas/);
    const nav = authedPage.getByRole('navigation').first();
    await expect(nav.getByRole('link', { name: 'Registrar' })).toBeVisible();
    await expect(authedPage.getByRole('link', { name: 'Más', exact: true })).toHaveCount(0);

    await authedPage.setViewportSize({ width: MOBILE_WIDTH, height: HEIGHT });
    await expect(authedPage).toHaveURL(/\/cuentas/);
    await expect(
      authedPage.getByRole('navigation').first().getByRole('link', { name: 'Más', exact: true }),
    ).toBeVisible();
  });

  test('RNF-06 RNF-05 sin violaciones de axe en el shell', async ({ authedPage, checkA11y }) => {
    await authedPage.goto('/');
    await expect(authedPage.getByRole('navigation').first()).toBeVisible();
    await checkA11y();
  });

  test('RNF-06 la barra lateral contraída se recorre con teclado', async ({ authedPage }) => {
    await authedPage.setViewportSize({ width: DESKTOP_WIDTH, height: HEIGHT });
    await authedPage.goto('/');
    await authedPage.getByRole('button', { name: /contraer/i }).click();
    const link = authedPage.getByRole('navigation').first().getByRole('link').first();
    await link.focus();
    await expect(link).toBeFocused();
    await expect(link).toHaveAccessibleName(/\S/);
  });
});
