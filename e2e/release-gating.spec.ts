import type { Page, Route } from '@playwright/test';

import { expect, test } from './fixtures/auth.js';

/**
 * TASK-222: with `RELEASE=1.0` no module of V1.1 shows up in the menu, Inicio or the header
 * (RF-M2-03). These cases only run with `e2e:release-1.0` (plan §5.1).
 *
 * TASK-247: with `RELEASE=1.1` no module of V1.2 shows up: Recurrentes, Ajustes › Recordatorios and
 * the types `log_day` and `goal_progress` (RF-M2-03). The screens read the release from the profile
 * (`GET /api/me`), so those cases make the session report release 1.1 and run in every suite; the
 * cases that need the API itself running with `RELEASE=1.1` skip themselves otherwise.
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

/** The release the API itself runs with, as the profile reports it. */
async function apiRelease(page: Page): Promise<string> {
  const res = await page.request.get('/api/me');
  expect(res.ok()).toBe(true);
  return ((await res.json()) as { release: string }).release;
}

const REMINDER_SWITCHES = [/registrar el día/i, /avance de metas/i] as const;

test.describe('TASK-247 entregas: V1.2 oculta con RELEASE=1.1', () => {
  test('RF-M2-03 con 1.1 Más ofrece los módulos de V1.1 pero no Recurrentes', async ({
    authedPage,
  }) => {
    await reportRelease(authedPage, '1.1');
    await authedPage.goto('/mas');
    await expect(authedPage.getByText(/^planificar$/i).first()).toBeVisible();
    await expect(authedPage.getByRole('main').getByRole('link', { name: /^presupuestos$/i })).toBeVisible();
    await expect(authedPage.getByRole('main').getByRole('link', { name: /^metas de ahorro$/i })).toBeVisible();
    await expect(authedPage.getByRole('main').getByRole('link', { name: /^deudas y préstamos$/i })).toBeVisible();
    await expect(authedPage.getByRole('link', { name: /^recurrentes$/i })).toHaveCount(0);
  });

  test('RF-M2-03 con 1.1 la barra lateral no ofrece Recurrentes', async ({ authedPage }) => {
    await reportRelease(authedPage, '1.1');
    await authedPage.setViewportSize({ width: DESKTOP_WIDTH, height: HEIGHT });
    await authedPage.goto('/');
    await settle(authedPage);
    await expect(authedPage.getByRole('link', { name: 'Presupuestos' }).first()).toBeVisible();
    await expect(authedPage.getByRole('link', { name: /^recurrentes$/i })).toHaveCount(0);
  });

  test('RF-M2-03 con 1.1 Ajustes no lista Recordatorios', async ({ authedPage }) => {
    await reportRelease(authedPage, '1.1');
    await authedPage.goto('/ajustes');
    const main = authedPage.getByRole('main');
    await expect(main.getByRole('link', { name: /^general/i })).toBeVisible();
    await expect(main.getByRole('link', { name: /recordatorios/i })).toHaveCount(0);
  });

  test('RF-M2-03 con 1.1 /ajustes/recordatorios no existe y no ofrece los tipos log_day ni goal_progress', async ({
    authedPage,
  }) => {
    await reportRelease(authedPage, '1.1');
    await authedPage.goto('/ajustes/recordatorios');
    await expect(authedPage.getByRole('heading', { name: 'Esto ya no existe.' })).toBeVisible();
    for (const name of REMINDER_SWITCHES) {
      await expect(authedPage.getByRole('switch', { name })).toHaveCount(0);
    }
    await expect(authedPage.getByRole('switch')).toHaveCount(0);
  });

  test('RF-M2-03 con 1.1 la bandeja de avisos sigue en la cabecera', async ({ authedPage }) => {
    await reportRelease(authedPage, '1.1');
    await authedPage.goto('/');
    await settle(authedPage);
    await expect(
      authedPage.getByRole('banner').getByRole('button', { name: /avisos/i }),
    ).toBeVisible();
  });

  test('RF-M2-03 con 1.2 Más sí ofrece Recurrentes y Ajustes sí lista Recordatorios', async ({
    authedPage,
  }) => {
    await reportRelease(authedPage, '1.2');
    await authedPage.goto('/mas');
    await expect(authedPage.getByRole('main').getByRole('link', { name: /^recurrentes$/i })).toBeVisible();
    await authedPage.goto('/ajustes');
    await expect(
      authedPage.getByRole('main').getByRole('link', { name: /recordatorios/i }),
    ).toBeVisible();
  });
});

test.describe('TASK-247 entregas: el API responde solo lo que su RELEASE libera', () => {
  /** Recurring rules and the notice configuration arrive with V1.2; the inbox with V1.1. */
  function expectedStatus(release: string, module: 'recurring' | 'preferences' | 'inbox'): number {
    const released =
      module === 'inbox' ? release === '1.1' || release === '1.2' : release === '1.2';
    return released ? 200 : 404;
  }

  const ENDPOINTS = [
    { module: 'recurring', path: '/api/recurring' },
    { module: 'preferences', path: '/api/notification-preferences' },
    { module: 'inbox', path: '/api/notifications?limit=50' },
  ] as const;

  test('RF-M2-03 cada módulo de V1.1 y V1.2 del API responde según la entrega liberada', async ({
    authedPage,
  }) => {
    const release = await apiRelease(authedPage);
    expect(['1.0', '1.1', '1.2']).toContain(release);
    for (const { module, path } of ENDPOINTS) {
      const res = await authedPage.request.get(path);
      expect(res.status(), `GET ${path} con RELEASE=${release}`).toBe(
        expectedStatus(release, module),
      );
      if (res.status() === 404) {
        expect(((await res.json()) as { code?: string }).code, `GET ${path}`).toBe(
          'RELEASE_NOT_AVAILABLE',
        );
      }
    }
  });

  test('RF-M2-03 con el API en 1.1 la bandeja no incluye los tipos de V1.2', async ({
    authedPage,
  }) => {
    const release = await apiRelease(authedPage);
    const res = await authedPage.request.get('/api/notifications?limit=50');
    if (release === '1.1') {
      expect(res.ok()).toBe(true);
      const types = ((await res.json()) as { items: { type: string }[] }).items.map((n) => n.type);
      for (const type of ['log_day', 'goal_progress', 'recurring_pending']) {
        expect(types).not.toContain(type);
      }
    } else {
      expect(res.status()).toBe(expectedStatus(release, 'inbox'));
    }
  });
});
