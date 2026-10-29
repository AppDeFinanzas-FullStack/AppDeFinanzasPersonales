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

function isoToday(): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/La_Paz' }).format(new Date());
}

async function createExpense(page: Page, accountId: string): Promise<string> {
  const cats = await page.request.get('/api/categories?kind=expense&status=active');
  expect(cats.ok()).toBe(true);
  const tree = (await cats.json()) as { id: string }[];
  const id = randomUUID();
  const res = await page.request.post('/api/transactions', {
    data: {
      kind: 'expense',
      id,
      accountId,
      categoryId: tree[0]?.id,
      amount: '10',
      date: isoToday(),
    },
  });
  expect(res.status()).toBe(201);
  return id;
}

async function expectOnlyHeaderBack(page: Page): Promise<void> {
  await expect(backButton(page)).toHaveCount(1);
  await expect(page.getByRole('main').getByRole('link', { name: /volver/i })).toHaveCount(0);
  await expect(page.getByRole('main').getByRole('button', { name: /volver/i })).toHaveCount(0);
}

test.describe('TASK-268 un solo Volver en las pantallas internas', () => {
  test.beforeEach(async ({ authedPage }) => {
    await authedPage.setViewportSize({ width: MOBILE_WIDTH, height: HEIGHT });
  });

  test('RF-M2-13 el detalle de una cuenta tiene un solo Volver', async ({ authedPage }) => {
    const id = await createAccount(authedPage, 'Unica');
    await authedPage.goto(`/cuentas/${id}`);
    await expectOnlyHeaderBack(authedPage);
  });

  test('RF-M2-13 el detalle de un presupuesto tiene un solo Volver', async ({ authedPage }) => {
    const id = randomUUID();
    const res = await authedPage.request.post('/api/budgets', {
      data: { id, scope: 'general', amount: '100', currencyCode: 'BOB' },
    });
    expect(res.status()).toBe(201);
    await authedPage.goto(`/presupuestos/${id}`);
    await expectOnlyHeaderBack(authedPage);
  });

  test('RF-M2-13 el detalle de una meta tiene un solo Volver', async ({ authedPage }) => {
    const id = randomUUID();
    const res = await authedPage.request.post('/api/goals', {
      data: {
        id,
        name: 'Viaje',
        target: '1000',
        currencyCode: 'BOB',
        icon: 'plane',
        color: 'blue',
      },
    });
    expect(res.status()).toBe(201);
    await authedPage.goto(`/metas/${id}`);
    await expectOnlyHeaderBack(authedPage);
  });

  test('RF-M2-13 el detalle de una deuda tiene un solo Volver', async ({ authedPage }) => {
    const id = randomUUID();
    const res = await authedPage.request.post('/api/debts', {
      data: {
        id,
        direction: 'i_owe',
        person: 'Ana',
        principal: '100',
        currencyCode: 'BOB',
        startDate: isoToday(),
      },
    });
    expect(res.status()).toBe(201);
    await authedPage.goto(`/deudas/${id}`);
    await expectOnlyHeaderBack(authedPage);
  });

  test('RF-M2-13 las pantallas de categorías tienen un solo Volver', async ({ authedPage }) => {
    const cats = await authedPage.request.get('/api/categories?kind=expense&status=active');
    const tree = (await cats.json()) as { id: string }[];
    for (const path of [
      '/categorias/nueva',
      '/categorias/archivadas',
      `/categorias/${tree[0]?.id}/editar`,
    ]) {
      await authedPage.goto(path);
      await expectOnlyHeaderBack(authedPage);
    }
  });

  test('RF-M2-13 el detalle de un movimiento tiene un solo Volver', async ({ authedPage }) => {
    const accountId = await createAccount(authedPage, 'Mov');
    const id = await createExpense(authedPage, accountId);
    await authedPage.goto(`/movimientos/${id}`);
    await expectOnlyHeaderBack(authedPage);
  });

  test('RF-M2-13 un movimiento eliminado desde otro dispositivo sigue ofreciendo Volver a Movimientos', async ({
    authedPage,
  }) => {
    const accountId = await createAccount(authedPage, 'Borrada');
    const id = await createExpense(authedPage, accountId);
    const del = await authedPage.request.delete(`/api/transactions/${id}`);
    expect(del.ok()).toBe(true);
    await authedPage.goto(`/movimientos/${id}`);
    const link = authedPage.getByRole('link', { name: 'Volver a Movimientos' });
    await expect(link).toBeVisible();
    await link.click();
    await expect(authedPage).toHaveURL(/\/movimientos$/);
  });
});
