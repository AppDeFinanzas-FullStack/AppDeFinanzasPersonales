import type { Locator } from '@playwright/test';

import { expect, test } from './fixtures/auth.js';
import { expectNoBlockingViolations } from './support/axe.js';

/**
 * TASK-270: the brand logo over the access screens and in the header of every screen with a bar,
 * as docs/design-direction.md ("Marca") sets it (RF-M2-14, RNF-06).
 */

const MOBILE_WIDTH = 360;
const DESKTOP_WIDTH = 1280;
const HEIGHT = 800;
const BRAND = 'Finanzas';

const THEMES = ['light', 'dark'] as const;

async function boxOf(locator: Locator) {
  const box = await locator.boundingBox();
  expect(box, 'the element has a box').not.toBeNull();
  return box!;
}

test.describe('TASK-270 el logo acompaña a la app', () => {
  test('RF-M2-14 el ícono de la pestaña responde 200', async ({ page }) => {
    await page.goto('/entrar');
    const href = await page.locator('link[rel="icon"]').first().getAttribute('href');
    expect(href).toBeTruthy();
    const res = await page.request.get(href!);
    expect(res.status()).toBe(200);
  });

  for (const path of ['/entrar', '/registro']) {
    test(`RF-M2-14 el logo de 48 px está sobre el título en ${path}`, async ({ page }) => {
      await page.goto(path);
      const logo = page.getByRole('main').getByRole('img', { name: BRAND });
      await expect(logo).toBeVisible();
      await expect(logo).toHaveAttribute('width', '48');
      const heading = page.getByRole('heading', { level: 1 });
      const logoBox = await boxOf(logo);
      const headingBox = await boxOf(heading);
      expect(logoBox.y + logoBox.height).toBeLessThanOrEqual(headingBox.y);
    });
  }

  for (const path of ['/', '/movimientos', '/cuentas', '/mas']) {
    test(`RF-M2-14 la cabecera de ${path} muestra el logo`, async ({ authedPage }) => {
      await authedPage.setViewportSize({ width: MOBILE_WIDTH, height: HEIGHT });
      await authedPage.goto(path);
      const logo = authedPage.getByRole('banner').getByRole('img', { name: BRAND });
      await expect(logo).toBeVisible();
      await expect(logo).toHaveAttribute('width', '24');
    });
  }

  for (const width of [MOBILE_WIDTH, DESKTOP_WIDTH]) {
    test(`RF-M2-14 en ${width} px el logo queda a la izquierda del título, y "Volver" a la izquierda del logo`, async ({
      authedPage,
    }) => {
      await authedPage.setViewportSize({ width, height: HEIGHT });
      // /cuentas/nueva hangs from /cuentas at both widths, so the header has "Volver".
      await authedPage.goto('/cuentas/nueva');
      const banner = authedPage.getByRole('banner');
      const logo = banner.getByRole('img', { name: BRAND });
      const heading = banner.getByRole('heading', { level: 1 });
      await expect(heading).toHaveText('Cuentas');
      const logoBox = await boxOf(logo);
      expect(logoBox.x + logoBox.width).toBeLessThanOrEqual((await boxOf(heading)).x);
      const back = banner.getByRole('button', { name: /volver/i });
      await expect(back).toBeVisible();
      const backBox = await boxOf(back);
      expect(backBox.x + backBox.width).toBeLessThanOrEqual(logoBox.x);
    });
  }

  test('cargar la pantalla no desplaza el título: el logo reserva su espacio', async ({ page }) => {
    let release: () => void = () => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    await page.route('**/logo.svg', async (route) => {
      await held;
      await route.continue();
    });
    await page.goto('/entrar');
    const heading = page.getByRole('heading', { level: 1 });
    await expect(heading).toBeVisible();
    const before = await boxOf(heading);
    release();
    const logo = page.getByRole('main').getByRole('img', { name: BRAND });
    await expect
      .poll(() => logo.evaluate((img: HTMLImageElement) => img.complete && img.naturalWidth > 0))
      .toBe(true);
    const after = await boxOf(heading);
    expect(after.y).toBe(before.y);
  });

  for (const theme of THEMES) {
    const name = theme === 'light' ? 'tema claro' : 'tema oscuro';

    test(`RNF-06 la pantalla de acceso con el logo sin violaciones serias de axe en ${name}`, async ({
      page,
    }) => {
      await page.emulateMedia({ colorScheme: theme });
      await page.goto('/entrar');
      await expect(page.getByRole('main').getByRole('img', { name: BRAND })).toBeVisible();
      await expectNoBlockingViolations(page);
    });

    test(`RNF-06 la cabecera con el logo sin violaciones serias de axe en ${name}`, async ({
      authedPage,
    }) => {
      await authedPage.emulateMedia({ colorScheme: theme });
      await authedPage.goto('/');
      await expect(authedPage.getByRole('banner').getByRole('img', { name: BRAND })).toBeVisible();
      await expectNoBlockingViolations(authedPage);
    });
  }
});
