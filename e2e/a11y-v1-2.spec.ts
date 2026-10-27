import { randomUUID } from 'node:crypto';

import type { Locator, Page } from '@playwright/test';

import { expect, test } from './fixtures/auth.js';
import { expectNoBlockingViolations } from './support/axe.js';

/**
 * TASK-247: every screen of V1.2 (Recurrentes, its dialogs, Ajustes › Recordatorios, the pending
 * notices of the inbox and the recurring payments of Inicio) and, with the full product, every
 * screen of the three deliveries has no serious or critical axe violation (WCAG 2.2 AA, RNF-06),
 * in the light and the dark theme, in the 6 projects of the matrix: Chromium, WebKit and Firefox
 * at 360 px and 1280 px (RNF-05).
 */

const THEMES = ['light', 'dark'] as const;
type Theme = (typeof THEMES)[number];

const THEME_NAME: Record<Theme, string> = { light: 'tema claro', dark: 'tema oscuro' };

interface CategoryNode {
  id: string;
  kind: string;
  status: string;
  children: CategoryNode[];
}

interface Notification {
  id: string;
  type: string;
}

interface World {
  cashId: string;
  pausedRuleId: string;
}

/** The user's local date (RN-07); the test users live in Bolivia. */
function localDate(offsetDays = 0): string {
  const at = new Date(Date.now() + offsetDays * 86_400_000);
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/La_Paz',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(at);
}

function flatten(nodes: CategoryNode[]): CategoryNode[] {
  return nodes.flatMap((n) => [n, ...flatten(n.children)]);
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
      initialBalanceDate: localDate(-40),
      color: 'teal',
      icon: 'wallet',
    },
  });
  expect(res.status(), `POST /api/accounts ${name}`).toBe(201);
  return id;
}

async function expenseCategoryId(page: Page): Promise<string> {
  const res = await page.request.get('/api/categories?kind=expense&status=active');
  expect(res.ok()).toBe(true);
  const found = flatten((await res.json()) as CategoryNode[]).find(
    (n) => n.kind === 'expense' && n.status === 'active',
  );
  expect(found).toBeDefined();
  return found?.id ?? '';
}

interface RuleOptions {
  name: string;
  accountId: string;
  mode: 'auto' | 'confirm';
  amount: string;
  frequency: Record<string, unknown>;
  startDate: string;
  end?: { type: 'none' } | { type: 'count'; count: number };
}

async function createRule(page: Page, options: RuleOptions): Promise<string> {
  const id = randomUUID();
  const res = await page.request.post('/api/recurring', {
    data: {
      id,
      name: options.name,
      kind: 'expense',
      amount: options.amount,
      accountId: options.accountId,
      categoryId: await expenseCategoryId(page),
      frequency: options.frequency,
      startDate: options.startDate,
      end: options.end ?? { type: 'none' },
      mode: options.mode,
    },
  });
  expect(res.status(), `POST /api/recurring ${options.name}`).toBe(201);
  return id;
}

async function pendingNotices(page: Page): Promise<Notification[]> {
  const res = await page.request.get('/api/notifications?limit=50');
  expect(res.ok()).toBe(true);
  return ((await res.json()) as { items: Notification[] }).items.filter(
    (n) => n.type === 'recurring_pending',
  );
}

/**
 * Rules for every screen of V1.2: a pending of today (and its notice in the inbox), an installment
 * rule, a paused rule, and an automatic payment that falls due in 3 days (it shows in Inicio).
 */
async function seedWorld(page: Page): Promise<World> {
  const cashId = await createAccount(page, 'Efectivo', '2000.00');
  await createRule(page, {
    name: 'Internet',
    accountId: cashId,
    mode: 'confirm',
    amount: '40.00',
    frequency: { type: 'daily' },
    startDate: localDate(),
  });
  await createRule(page, {
    name: 'Gimnasio',
    accountId: cashId,
    mode: 'confirm',
    amount: '20.00',
    frequency: { type: 'weekly', weekday: 1 },
    startDate: localDate(1),
    end: { type: 'count', count: 5 },
  });
  const inThree = localDate(3);
  await createRule(page, {
    name: 'Alquiler',
    accountId: cashId,
    mode: 'auto',
    amount: '300.00',
    frequency: { type: 'monthly', day: Number(inThree.slice(8, 10)) },
    startDate: inThree,
  });
  const pausedRuleId = await createRule(page, {
    name: 'Seguro',
    accountId: cashId,
    mode: 'confirm',
    amount: '15.00',
    frequency: { type: 'weekly', weekday: 2 },
    startDate: localDate(2),
  });
  const pause = await page.request.post(`/api/recurring/${pausedRuleId}/pause`);
  expect(pause.ok(), 'POST /api/recurring/:id/pause').toBe(true);
  await expect.poll(async () => (await pendingNotices(page)).length).toBeGreaterThan(0);
  return { cashId, pausedRuleId };
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

function bell(page: Page): Locator {
  return page.getByRole('banner').getByRole('button', { name: /avisos/i });
}

/** A pending of "Pendientes de confirmar": the smallest block with its name and Confirmar. */
function recurringPending(page: Page, ruleName: string): Locator {
  return page
    .locator('li, article, [role="listitem"], [role="group"], div')
    .filter({ hasText: ruleName })
    .filter({ has: page.getByRole('button', { name: 'Confirmar', exact: true }) })
    .last();
}

/** Opens a dialog with the click on `trigger` and waits until it is visible and quiet. */
async function openDialogWith(page: Page, trigger: Locator): Promise<Locator> {
  await trigger.click();
  const dialog = page.getByRole('dialog');
  await expect(dialog).toBeVisible();
  await page.waitForLoadState('networkidle');
  return dialog;
}

/** The screens of the full product, from V1.0 to V1.2 (RNF-06: "todo el producto"). */
const PRODUCT_SCREENS: readonly { name: string; path: string }[] = [
  { name: 'Inicio', path: '/' },
  { name: 'Movimientos', path: '/movimientos' },
  { name: 'Registrar', path: '/registrar' },
  { name: 'Cuentas', path: '/cuentas' },
  { name: 'Categorías', path: '/categorias' },
  { name: 'Tipo de cambio', path: '/tipo-de-cambio' },
  { name: 'Presupuestos', path: '/presupuestos' },
  { name: 'Metas de ahorro', path: '/metas' },
  { name: 'Deudas y préstamos', path: '/deudas' },
  { name: 'Recurrentes', path: '/recurrentes' },
  { name: 'Más', path: '/mas' },
  { name: 'Perfil', path: '/perfil' },
  { name: 'Ajustes', path: '/ajustes' },
  { name: 'Ajustes › General', path: '/ajustes/general' },
  { name: 'Ajustes › Monedas', path: '/ajustes/monedas' },
  { name: 'Ajustes › Registrar', path: '/ajustes/registrar' },
  { name: 'Ajustes › Inicio', path: '/ajustes/inicio' },
  { name: 'Ajustes › Recordatorios', path: '/ajustes/recordatorios' },
];

for (const theme of THEMES) {
  test.describe(`TASK-247 accesibilidad de V1.2 en ${THEME_NAME[theme]}`, () => {
    test(`RNF-06 RNF-05 Recurrentes con reglas, pendientes y vencimientos sin violaciones serias de axe en ${THEME_NAME[theme]}`, async ({
      authedPage,
    }) => {
      await seedWorld(authedPage);
      await useTheme(authedPage, theme);
      await open(authedPage, '/recurrentes', theme);
      await expect(
        authedPage.getByRole('heading', { name: 'Pendientes de confirmar' }),
      ).toBeVisible();
      await expect(recurringPending(authedPage, 'Internet')).toBeVisible();
      await expect(authedPage.getByText(/Cuota \d+ de 5/).first()).toBeVisible();
      await expectNoBlockingViolations(authedPage);
    });

    test(`RNF-06 RNF-05 Recurrentes vacía sin violaciones serias de axe en ${THEME_NAME[theme]}`, async ({
      authedPage,
    }) => {
      await useTheme(authedPage, theme);
      await open(authedPage, '/recurrentes', theme);
      await expect(authedPage.getByText('Aún no tienes reglas recurrentes.')).toBeVisible();
      await expectNoBlockingViolations(authedPage);
    });

    test(`RNF-06 RNF-05 Nueva regla recurrente sin violaciones serias de axe en ${THEME_NAME[theme]}`, async ({
      authedPage,
    }) => {
      await createAccount(authedPage, 'Efectivo', '500.00');
      await useTheme(authedPage, theme);
      await open(authedPage, '/recurrentes', theme);
      await openDialogWith(authedPage, authedPage.getByRole('button', { name: 'Nueva regla' }));
      await expectNoBlockingViolations(authedPage);
    });

    test(`RNF-06 RNF-05 Nueva regla con errores de validación sin violaciones serias de axe en ${THEME_NAME[theme]}`, async ({
      authedPage,
    }) => {
      await createAccount(authedPage, 'Efectivo', '500.00');
      await useTheme(authedPage, theme);
      await open(authedPage, '/recurrentes', theme);
      const dialog = await openDialogWith(
        authedPage,
        authedPage.getByRole('button', { name: 'Nueva regla' }),
      );
      await dialog.getByRole('radio', { name: 'Automático' }).check();
      await dialog.getByRole('button', { name: 'Guardar' }).click();
      await expect(dialog).toBeVisible();
      await expect(dialog.getByText(/ingresa|escribe|elige/i).first()).toBeVisible();
      await expectNoBlockingViolations(authedPage);
    });

    test(`RNF-06 RNF-05 Confirmar un pendiente sin violaciones serias de axe en ${THEME_NAME[theme]}`, async ({
      authedPage,
    }) => {
      await seedWorld(authedPage);
      await useTheme(authedPage, theme);
      await open(authedPage, '/recurrentes', theme);
      const dialog = await openDialogWith(
        authedPage,
        recurringPending(authedPage, 'Internet').getByRole('button', {
          name: 'Confirmar',
          exact: true,
        }),
      );
      await expect(dialog.getByLabel('Fecha')).toBeVisible();
      await expectNoBlockingViolations(authedPage);
    });

    test(`RNF-06 RNF-05 Reanudar una regla con ocurrencias saltadas sin violaciones serias de axe en ${THEME_NAME[theme]}`, async ({
      authedPage,
    }) => {
      const world = await seedWorld(authedPage);
      await authedPage.route(`**/api/recurring/${world.pausedRuleId}/skipped`, (route) =>
        route.fulfill({ status: 200, json: { dates: [localDate(-14), localDate(-7)] } }),
      );
      await useTheme(authedPage, theme);
      await open(authedPage, '/recurrentes', theme);
      const dialog = await openDialogWith(
        authedPage,
        authedPage.getByRole('button', { name: 'Reanudar' }).first(),
      );
      await expect(dialog.getByRole('checkbox')).toHaveCount(2);
      await expectNoBlockingViolations(authedPage);
    });

    test(`RNF-06 RNF-05 Ajustes con la sección Recordatorios sin violaciones serias de axe en ${THEME_NAME[theme]}`, async ({
      authedPage,
    }) => {
      await useTheme(authedPage, theme);
      await open(authedPage, '/ajustes', theme);
      await expect(
        authedPage.getByRole('main').getByRole('link', { name: /recordatorios/i }),
      ).toBeVisible();
      await expectNoBlockingViolations(authedPage);
    });

    test(`RNF-06 RNF-05 Ajustes › Recordatorios sin violaciones serias de axe en ${THEME_NAME[theme]}`, async ({
      authedPage,
    }) => {
      await useTheme(authedPage, theme);
      await open(authedPage, '/ajustes/recordatorios', theme);
      await expect(
        authedPage.getByRole('main').getByRole('switch', { name: /pendientes? de recurrentes?/i }),
      ).toBeVisible();
      await expectNoBlockingViolations(authedPage);
    });

    test(`RNF-06 RNF-05 Ajustes › Recordatorios con todos los avisos activados sin violaciones serias de axe en ${THEME_NAME[theme]}`, async ({
      authedPage,
    }) => {
      const res = await authedPage.request.patch('/api/notification-preferences', {
        data: [
          { type: 'payment_upcoming', enabled: true, leadDays: 2 },
          { type: 'log_day', enabled: true, hour: 20, weekdays: [1, 2, 3, 4, 5] },
          { type: 'goal_progress', enabled: true },
        ],
      });
      expect(res.ok(), 'PATCH /api/notification-preferences').toBe(true);
      await useTheme(authedPage, theme);
      await open(authedPage, '/ajustes/recordatorios', theme);
      await expect(
        authedPage.getByRole('main').getByRole('switch', { name: /registrar el día/i }),
      ).toHaveAttribute('aria-checked', 'true');
      await expect(authedPage.getByLabel(/hora del recordatorio/i)).toBeVisible();
      await expectNoBlockingViolations(authedPage);
    });

    test(`RNF-06 RNF-05 Inicio con un recurrente por vencer sin violaciones serias de axe en ${THEME_NAME[theme]}`, async ({
      authedPage,
    }) => {
      await seedWorld(authedPage);
      await useTheme(authedPage, theme);
      await open(authedPage, '/', theme);
      const block = authedPage.getByRole('region', { name: 'Próximos pagos y deudas' });
      await expect(block.getByText('Alquiler')).toBeVisible();
      await expectNoBlockingViolations(authedPage);
    });

    test(`RNF-06 RNF-05 Más con Recurrentes sin violaciones serias de axe en ${THEME_NAME[theme]}`, async ({
      authedPage,
    }) => {
      await useTheme(authedPage, theme);
      await open(authedPage, '/mas', theme);
      await expect(authedPage.getByRole('link', { name: 'Recurrentes' }).first()).toBeVisible();
      await expectNoBlockingViolations(authedPage);
    });

    test(`RNF-06 RNF-05 Bandeja con un aviso de pendiente sin violaciones serias de axe en ${THEME_NAME[theme]}`, async ({
      authedPage,
    }) => {
      await seedWorld(authedPage);
      await useTheme(authedPage, theme);
      await open(authedPage, '/', theme);
      await expect(bell(authedPage)).toBeVisible();
      await bell(authedPage).click();
      const panel = authedPage
        .getByRole('dialog')
        .filter({ has: authedPage.getByRole('listitem') })
        .first();
      await expect(panel).toBeVisible();
      await expect(
        panel.getByRole('listitem').first().getByRole('button', { name: 'Confirmar', exact: true }),
      ).toBeVisible();
      await authedPage.waitForLoadState('networkidle');
      await expectNoBlockingViolations(authedPage);
    });
  });

  test.describe(`TASK-247 accesibilidad de todo el producto en ${THEME_NAME[theme]}`, () => {
    for (const screen of PRODUCT_SCREENS) {
      test(`RNF-06 RNF-05 ${screen.name} del producto completo sin violaciones serias de axe en ${THEME_NAME[theme]}`, async ({
        authedPage,
      }) => {
        await seedWorld(authedPage);
        await useTheme(authedPage, theme);
        await open(authedPage, screen.path, theme);
        await expectNoBlockingViolations(authedPage);
      });
    }
  });
}

test.describe('TASK-247 textos de V1.2 en español', () => {
  const KEY_LIKE = /\b(recurring|settings|notifications|navigation|errors)\.[a-zA-Z]+(\.[a-zA-Z]+)*\b/;

  test('RNF-07 Recurrentes muestra textos en español y ninguna clave de traducción', async ({
    authedPage,
  }) => {
    await seedWorld(authedPage);
    await open(authedPage, '/recurrentes', 'light');
    await expect(authedPage.locator('html')).toHaveAttribute('lang', /^es/);
    const text = await authedPage.getByRole('main').innerText();
    expect(text).toContain('Pendientes de confirmar');
    expect(text).toContain('Próximos vencimientos');
    expect(text).not.toMatch(KEY_LIKE);
  });

  test('RNF-07 Ajustes › Recordatorios muestra textos en español y ninguna clave de traducción', async ({
    authedPage,
  }) => {
    await open(authedPage, '/ajustes/recordatorios', 'light');
    const text = await authedPage.getByRole('main').innerText();
    expect(text).toContain('Registrar el día');
    expect(text).toContain('Avance de metas');
    expect(text).not.toMatch(KEY_LIKE);
  });
});
