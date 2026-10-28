import { randomUUID } from 'node:crypto';

import type { Locator, Page } from '@playwright/test';

import { expect, test } from './fixtures/auth.js';
import { expectNoBlockingViolations } from './support/axe.js';

const MOBILE_WIDTH = 360;
const DESKTOP_WIDTH = 1280;
const HEIGHT = 800;
const MIN_TARGET = 44;
const SCROLL_TARGET = 300;

async function createAccount(page: Page, name: string): Promise<string> {
  const id = randomUUID();
  const res = await page.request.post('/api/accounts', {
    data: {
      id,
      type: 'cash',
      name,
      currencyCode: 'BOB',
      initialBalance: '500',
      initialBalanceDate: '2020-01-01',
      color: 'teal',
      icon: 'wallet',
    },
  });
  expect(res.status()).toBe(201);
  return id;
}

function backButton(page: Page): Locator {
  return page.getByRole('button', { name: 'Volver', exact: true });
}

function detailUrl(id: string): RegExp {
  return new RegExp(`/cuentas/${id}$`);
}

test.describe('TASK-267 botón Volver en la cabecera', () => {
  test.beforeEach(async ({ authedPage }) => {
    await authedPage.setViewportSize({ width: MOBILE_WIDTH, height: HEIGHT });
  });

  test('RF-M2-13 Volver desde una pantalla interna: del detalle de una cuenta regresa a Cuentas', async ({
    authedPage,
  }) => {
    const id = await createAccount(authedPage, 'Efectivo');
    await authedPage.goto('/cuentas');
    await authedPage.addStyleTag({ content: 'body { min-height: 3000px; }' });
    await authedPage.evaluate((y) => window.scrollTo(0, y), SCROLL_TARGET);
    await expect.poll(() => authedPage.evaluate(() => window.scrollY)).toBeGreaterThan(0);

    await authedPage.locator(`a[href="/cuentas/${id}"]`).first().click();
    await expect(authedPage).toHaveURL(detailUrl(id));
    await backButton(authedPage).click();

    await expect(authedPage).toHaveURL(/\/cuentas$/);
    await expect.poll(() => authedPage.evaluate(() => window.scrollY)).toBeGreaterThan(0);
  });

  test('EC-M2-04 por enlace directo, Volver lleva a /cuentas y no sale de la app', async ({
    authedPage,
  }) => {
    const id = await createAccount(authedPage, 'Directa');
    await authedPage.goto(`/cuentas/${id}`);
    await backButton(authedPage).click();
    await expect(authedPage).toHaveURL(/\/cuentas$/);
  });

  for (const path of ['/', '/movimientos', '/registrar', '/cuentas', '/mas']) {
    test(`RF-M2-13 no hay Volver en ${path}`, async ({ authedPage }) => {
      await authedPage.goto(path);
      await expect(authedPage.getByRole('banner')).toBeVisible();
      await expect(backButton(authedPage)).toHaveCount(0);
    });
  }

  for (const path of ['/presupuestos', '/recurrentes']) {
    test(`RF-M2-13 en 360 px ${path} tiene Volver hacia /mas`, async ({ authedPage }) => {
      await authedPage.goto(path);
      await backButton(authedPage).click();
      await expect(authedPage).toHaveURL(/\/mas$/);
    });

    test(`RF-M2-13 en 1280 px ${path} no tiene Volver`, async ({ authedPage }) => {
      await authedPage.setViewportSize({ width: DESKTOP_WIDTH, height: HEIGHT });
      await authedPage.goto(path);
      await expect(authedPage.getByRole('banner')).toBeVisible();
      await expect(backButton(authedPage)).toHaveCount(0);
    });
  }

  test('RF-M2-10 volver desde otra pantalla conserva el borrador de Registrar', async ({
    authedPage,
  }) => {
    const id = await createAccount(authedPage, 'Efectivo');
    await authedPage.goto('/registrar');
    await authedPage.getByLabel(/monto/i).first().fill('77');
    await expect
      .poll(() =>
        authedPage.evaluate(() => Object.keys(sessionStorage).some((k) => k.startsWith('draft:'))),
      )
      .toBe(true);

    await authedPage.goto(`/cuentas/${id}`);
    await backButton(authedPage).click();
    await expect(authedPage).toHaveURL(/\/cuentas$/);
    await authedPage
      .getByRole('navigation')
      .first()
      .getByRole('link', { name: 'Registrar' })
      .click();

    await expect(authedPage.getByLabel(/monto/i).first()).toHaveValue('77');
  });

  test('RF-M2-06 el botón Atrás del navegador sigue funcionando en las pantallas internas', async ({
    authedPage,
  }) => {
    const id = await createAccount(authedPage, 'Atras');
    await authedPage.goto('/cuentas');
    await authedPage.locator(`a[href="/cuentas/${id}"]`).first().click();
    await expect(authedPage).toHaveURL(detailUrl(id));
    await authedPage.goBack();
    await expect(authedPage).toHaveURL(/\/cuentas$/);
    await authedPage.goForward();
    await expect(authedPage).toHaveURL(detailUrl(id));
  });

  test('RNF-06 Volver mide al menos 44 px, tiene nombre accesible y axe no reporta violaciones serias', async ({
    authedPage,
  }) => {
    const id = await createAccount(authedPage, 'Accesible');
    await authedPage.goto(`/cuentas/${id}`);
    const button = backButton(authedPage);
    await expect(button).toBeVisible();
    const box = await button.boundingBox();
    expect(box?.width ?? 0).toBeGreaterThanOrEqual(MIN_TARGET);
    expect(box?.height ?? 0).toBeGreaterThanOrEqual(MIN_TARGET);
    await expectNoBlockingViolations(authedPage);
  });
});
