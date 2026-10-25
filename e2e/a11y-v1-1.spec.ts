import { randomUUID } from 'node:crypto';

import type { Locator, Page } from '@playwright/test';

import { expect, test, type TestUser } from './fixtures/auth.js';
import { expectNoBlockingViolations } from './support/axe.js';

/**
 * TASK-222: every screen of V1.1 (budgets, goals, debts, the inbox and the new blocks of Inicio)
 * has no serious or critical axe violation (WCAG 2.2 AA, RNF-06), in the light and the dark theme,
 * in the 6 projects of the matrix: Chromium, WebKit and Firefox at 360 px and 1280 px (RNF-05).
 */

const API_URL = `http://localhost:${process.env['API_PORT'] ?? '3000'}`;
const BOLIVIA_OFFSET_MS = 4 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

const THEMES = ['light', 'dark'] as const;
type Theme = (typeof THEMES)[number];

const THEME_NAME: Record<Theme, string> = { light: 'tema claro', dark: 'tema oscuro' };

interface World {
  budgetId: string;
  goalId: string;
  debtId: string;
}

/** The day `offset` days from today in Bolivia (UTC-4), as `YYYY-MM-DD`. */
function dayFromToday(offset: number): string {
  return new Date(Date.now() - BOLIVIA_OFFSET_MS + offset * DAY_MS).toISOString().slice(0, 10);
}

/** First day of the previous calendar month in Bolivia, as `YYYY-MM-DD`. */
function previousMonthStart(): string {
  const now = new Date(Date.now() - BOLIVIA_OFFSET_MS);
  const y = now.getUTCMonth() === 0 ? now.getUTCFullYear() - 1 : now.getUTCFullYear();
  const m = now.getUTCMonth() === 0 ? 12 : now.getUTCMonth();
  return `${String(y)}-${String(m).padStart(2, '0')}-01`;
}

async function createAccount(page: Page, name: string, initialBalance: string): Promise<string> {
  const id = randomUUID();
  const res = await page.request.post('/api/accounts', {
    data: {
      id,
      type: 'cash',
      name,
      currencyCode: 'BOB',
      initialBalance,
      initialBalanceDate: previousMonthStart(),
      color: 'teal',
      icon: 'wallet',
    },
  });
  expect(res.status(), `POST /api/accounts ${name}`).toBe(201);
  return id;
}

async function createBudget(page: Page): Promise<string> {
  const id = randomUUID();
  const res = await page.request.post('/api/budgets', {
    data: { id, scope: 'general', amount: '1000.00', currencyCode: 'BOB' },
  });
  expect(res.status(), 'POST /api/budgets').toBe(201);
  return id;
}

async function createGoal(page: Page): Promise<string> {
  const id = randomUUID();
  const res = await page.request.post('/api/goals', {
    data: {
      id,
      name: 'Viaje',
      target: '5000.00',
      currencyCode: 'BOB',
      icon: 'plane',
      color: 'blue',
    },
  });
  expect(res.status(), 'POST /api/goals').toBe(201);
  return id;
}

async function createDebt(page: Page): Promise<string> {
  const id = randomUUID();
  const res = await page.request.post('/api/debts', {
    data: {
      id,
      direction: 'i_owe',
      person: 'Carla',
      principal: '300.00',
      currencyCode: 'BOB',
      startDate: dayFromToday(-10),
      dueDate: dayFromToday(3),
    },
  });
  expect(res.status(), 'POST /api/debts').toBe(201);
  return id;
}

/** A notification for the user, through the test endpoint (only with `INTEGRATIONS=fake`). */
async function createNotification(page: Page, user: TestUser): Promise<void> {
  const res = await page.request.post(`${API_URL}/internal/test/notifications`, {
    data: {
      email: user.email,
      eventKey: `e2e:${randomUUID()}`,
      type: 'budget_alert',
      targetRoute: '/presupuestos',
      params: {},
    },
  });
  expect(res.status(), 'POST /internal/test/notifications').toBe(201);
}

/** A budget, a goal and a debt due soon, so that every V1.1 screen shows real content. */
async function seedWorld(page: Page): Promise<World> {
  await createAccount(page, 'Efectivo', '500');
  const budgetId = await createBudget(page);
  const goalId = await createGoal(page);
  const debtId = await createDebt(page);
  return { budgetId, goalId, debtId };
}

async function useTheme(page: Page, theme: Theme): Promise<void> {
  await page.emulateMedia({ colorScheme: theme });
}

async function expectThemeApplied(page: Page, theme: Theme): Promise<void> {
  if (theme === 'dark') {
    await expect(page.locator('html')).toHaveClass(/dark/);
  } else {
    await expect(page.locator('html')).not.toHaveClass(/dark/);
  }
}

/** Waits until the screen has its content: the route loaded and no skeleton left. */
async function settle(page: Page): Promise<void> {
  await expect(page.getByRole('main')).toBeVisible();
  await expect(page.locator('.animate-pulse')).toHaveCount(0);
  await page.waitForLoadState('networkidle');
  await page.evaluate(() => document.fonts.ready);
}

async function open(page: Page, path: string, theme: Theme): Promise<void> {
  await page.goto(path);
  await expectThemeApplied(page, theme);
  await settle(page);
}

/** Opens a dialog from the first button or link whose name matches and waits for it. */
async function openDialog(page: Page, name: RegExp): Promise<void> {
  await page
    .getByRole('button', { name })
    .or(page.getByRole('link', { name }))
    .first()
    .click();
  await expect(page.getByRole('dialog')).toBeVisible();
  await page.waitForLoadState('networkidle');
}

function bell(page: Page): Locator {
  return page.getByRole('banner').getByRole('button', { name: /avisos/i });
}

const SCREENS: readonly { name: string; path: (world: World) => string }[] = [
  { name: 'Presupuestos', path: () => '/presupuestos' },
  { name: 'Detalle de un presupuesto', path: (w) => `/presupuestos/${w.budgetId}` },
  { name: 'Metas de ahorro', path: () => '/metas' },
  { name: 'Detalle de una meta', path: (w) => `/metas/${w.goalId}` },
  { name: 'Deudas y préstamos', path: () => '/deudas' },
  { name: 'Detalle de una deuda', path: (w) => `/deudas/${w.debtId}` },
];

for (const theme of THEMES) {
  test.describe(`TASK-222 accesibilidad de V1.1 en ${THEME_NAME[theme]}`, () => {
    for (const screen of SCREENS) {
      test(`RNF-06 RNF-05 ${screen.name} sin violaciones serias de axe en ${THEME_NAME[theme]}`, async ({
        authedPage,
      }) => {
        const world = await seedWorld(authedPage);
        await useTheme(authedPage, theme);
        await open(authedPage, screen.path(world), theme);
        await expectNoBlockingViolations(authedPage);
      });
    }

    test(`RNF-06 RNF-05 Inicio con los bloques de presupuestos y próximos pagos sin violaciones serias de axe en ${THEME_NAME[theme]}`, async ({
      authedPage,
    }) => {
      await seedWorld(authedPage);
      await useTheme(authedPage, theme);
      await open(authedPage, '/', theme);
      await expect(authedPage.getByText('Presupuesto del mes').first()).toBeVisible();
      await expect(authedPage.getByText('Próximos pagos y deudas').first()).toBeVisible();
      await expectNoBlockingViolations(authedPage);
    });

    test(`RNF-06 RNF-05 Más con la sección PLANIFICAR sin violaciones serias de axe en ${THEME_NAME[theme]}`, async ({
      authedPage,
    }) => {
      await useTheme(authedPage, theme);
      await open(authedPage, '/mas', theme);
      await expect(authedPage.getByText(/^planificar$/i).first()).toBeVisible();
      await expectNoBlockingViolations(authedPage);
    });

    test(`RNF-06 RNF-05 Nuevo presupuesto sin violaciones serias de axe en ${THEME_NAME[theme]}`, async ({
      authedPage,
    }) => {
      await createAccount(authedPage, 'Efectivo', '500');
      await useTheme(authedPage, theme);
      await open(authedPage, '/presupuestos', theme);
      await openDialog(authedPage, /nuevo presupuesto|crear presupuesto/i);
      await expectNoBlockingViolations(authedPage);
    });

    test(`RNF-06 RNF-05 Nueva meta sin violaciones serias de axe en ${THEME_NAME[theme]}`, async ({
      authedPage,
    }) => {
      await createAccount(authedPage, 'Efectivo', '500');
      await useTheme(authedPage, theme);
      await open(authedPage, '/metas', theme);
      await openDialog(authedPage, /nueva meta|crear meta/i);
      await expectNoBlockingViolations(authedPage);
    });

    test(`RNF-06 RNF-05 Nueva deuda sin violaciones serias de axe en ${THEME_NAME[theme]}`, async ({
      authedPage,
    }) => {
      await createAccount(authedPage, 'Efectivo', '500');
      await useTheme(authedPage, theme);
      await open(authedPage, '/deudas', theme);
      await authedPage
        .getByRole('button', { name: /nueva deuda/i })
        .or(authedPage.getByRole('link', { name: /nueva deuda/i }))
        .first()
        .click();
      await expect(authedPage.getByRole('button', { name: /^guardar$/i })).toBeVisible();
      await authedPage.waitForLoadState('networkidle');
      await expectNoBlockingViolations(authedPage);
    });

    test(`RNF-06 RNF-05 Bandeja de avisos abierta desde la campana sin violaciones serias de axe en ${THEME_NAME[theme]}`, async ({
      authedPage,
      testUser,
    }) => {
      await createNotification(authedPage, testUser);
      await useTheme(authedPage, theme);
      await open(authedPage, '/', theme);
      await expect(bell(authedPage)).toBeVisible();
      await expectNoBlockingViolations(authedPage);

      await bell(authedPage).click();
      await expect(authedPage.getByRole('dialog')).toBeVisible();
      await expect(authedPage.getByRole('dialog').getByRole('listitem').first()).toBeVisible();
      await authedPage.waitForLoadState('networkidle');
      await expectNoBlockingViolations(authedPage);
    });
  });
}
