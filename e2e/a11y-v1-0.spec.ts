import { randomUUID } from 'node:crypto';

import type { Page } from '@playwright/test';

import { expect, test } from './fixtures/auth.js';
import { expectNoBlockingViolations } from './support/axe.js';

/**
 * TASK-169: every screen of V1.0 has no serious or critical axe violation (WCAG 2.2 AA, RNF-06),
 * in the light and the dark theme, in the 6 projects of the matrix: Chromium, WebKit and Firefox
 * at 360 px and at 1280 px (RNF-05).
 */

const PASSWORD = 'Contrasena-segura-1';
const BOLIVIA_OFFSET_MS = 4 * 60 * 60 * 1000;

const THEMES = ['light', 'dark'] as const;
type Theme = (typeof THEMES)[number];

const THEME_NAME: Record<Theme, string> = { light: 'tema claro', dark: 'tema oscuro' };

interface CategoryNode {
  id: string;
  kind: string;
  status: string;
  isSystem?: boolean;
  children: CategoryNode[];
}

interface TransactionList {
  items: { id: string }[];
}

interface World {
  accountId: string;
  transactionId: string;
  categoryId: string;
}

const pad = (n: number): string => String(n).padStart(2, '0');

function bolivianToday(): { y: number; m: number; d: number } {
  const now = new Date(Date.now() - BOLIVIA_OFFSET_MS);
  return { y: now.getUTCFullYear(), m: now.getUTCMonth() + 1, d: now.getUTCDate() };
}

function todayText(): string {
  const t = bolivianToday();
  return `${t.y}-${pad(t.m)}-${pad(t.d)}`;
}

function previousMonthStart(): string {
  const { y, m } = bolivianToday();
  const index = y * 12 + (m - 1) - 1;
  return `${Math.floor(index / 12)}-${pad((index % 12) + 1)}-01`;
}

function flatten(nodes: CategoryNode[]): CategoryNode[] {
  return nodes.flatMap((n) => [n, ...flatten(n.children)]);
}

async function createAccount(
  page: Page,
  name: string,
  type: 'cash' | 'bank',
  initialBalance: string,
): Promise<string> {
  const id = randomUUID();
  const res = await page.request.post('/api/accounts', {
    data: {
      id,
      type,
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

async function activeCategories(page: Page, kind: 'expense' | 'income'): Promise<CategoryNode[]> {
  const res = await page.request.get(`/api/categories?kind=${kind}&status=active`);
  expect(res.ok()).toBe(true);
  return flatten((await res.json()) as CategoryNode[]).filter(
    (node) => node.kind === kind && node.status === 'active',
  );
}

async function record(
  page: Page,
  kind: 'expense' | 'income',
  accountId: string,
  categoryId: string,
  amount: string,
  note: string,
): Promise<void> {
  const res = await page.request.post('/api/transactions', {
    data: { kind, id: randomUUID(), accountId, categoryId, amount, date: todayText(), note },
  });
  expect(res.status(), `POST /api/transactions ${note}`).toBe(201);
}

/** Accounts, movements and a shortcut, so that every screen shows real content. */
async function seedWorld(page: Page): Promise<World> {
  const accountId = await createAccount(page, 'Efectivo', 'cash', '500');
  const savingsId = await createAccount(page, 'Banco Sol', 'bank', '1200');
  const expenses = await activeCategories(page, 'expense');
  const incomes = await activeCategories(page, 'income');
  const expense = expenses.find((node) => node.isSystem !== true) ?? expenses[0];
  const income = incomes[0];
  expect(expense).toBeDefined();
  expect(income).toBeDefined();
  const categoryId = expense?.id ?? '';
  await record(page, 'expense', accountId, categoryId, '35', 'Almuerzo');
  await record(page, 'expense', savingsId, categoryId, '120', 'Pasajes');
  await record(page, 'income', accountId, income?.id ?? '', '300', 'Sueldo');
  const shortcut = await page.request.post('/api/shortcuts', {
    data: { id: randomUUID(), name: 'Almuerzo', kind: 'expense', accountId, categoryId },
  });
  expect(shortcut.status()).toBe(201);

  const list = await page.request.get('/api/transactions');
  expect(list.ok()).toBe(true);
  const first = ((await list.json()) as TransactionList).items[0];
  expect(first).toBeDefined();
  return { accountId, transactionId: first?.id ?? '', categoryId };
}

/** Sets the theme the app follows (the setting of a new user is "Sistema"). */
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

async function openAndCheck(page: Page, path: string, theme: Theme): Promise<void> {
  await page.goto(path);
  await expectThemeApplied(page, theme);
  await settle(page);
  await expectNoBlockingViolations(page);
}

const PUBLIC_SCREENS = [
  { name: 'Registro', path: '/registro' },
  { name: 'Entrar', path: '/entrar' },
  { name: 'Olvidé mi contraseña', path: '/olvide-mi-contrasena' },
  { name: 'Restablecer contraseña con enlace inválido', path: '/restablecer' },
  { name: 'Restablecer contraseña con enlace', path: '/restablecer?token=enlace-de-prueba' },
  { name: 'Confirmar con enlace inválido', path: '/confirmar?token=enlace-de-prueba' },
] as const;

const AUTHED_SCREENS: readonly { name: string; path: (world: World) => string }[] = [
  { name: 'Inicio', path: () => '/' },
  { name: 'Movimientos', path: () => '/movimientos' },
  { name: 'Detalle de un movimiento', path: (w) => `/movimientos/${w.transactionId}` },
  { name: 'Registrar', path: () => '/registrar' },
  { name: 'Cuentas', path: () => '/cuentas' },
  { name: 'Cuenta nueva', path: () => '/cuentas/nueva' },
  { name: 'Detalle de una cuenta', path: (w) => `/cuentas/${w.accountId}` },
  { name: 'Editar una cuenta', path: (w) => `/cuentas/${w.accountId}/editar` },
  { name: 'Más', path: () => '/mas' },
  { name: 'Categorías', path: () => '/categorias' },
  { name: 'Categoría nueva', path: () => '/categorias/nueva' },
  { name: 'Categorías archivadas', path: () => '/categorias/archivadas' },
  { name: 'Editar una categoría', path: (w) => `/categorias/${w.categoryId}/editar` },
  { name: 'Tipo de cambio', path: () => '/tipo-de-cambio' },
  { name: 'Perfil', path: () => '/perfil' },
  { name: 'Eliminar la cuenta', path: () => '/perfil/eliminar' },
  { name: 'Ajustes', path: () => '/ajustes' },
  { name: 'Ajustes › General', path: () => '/ajustes/general' },
  { name: 'Ajustes › Monedas y tipo de cambio', path: () => '/ajustes/monedas' },
  { name: 'Ajustes › Registrar', path: () => '/ajustes/registrar' },
  { name: 'Ajustes › Inicio', path: () => '/ajustes/inicio' },
];

for (const theme of THEMES) {
  test.describe(`TASK-169 accesibilidad de V1.0 en ${THEME_NAME[theme]}`, () => {
    for (const screen of PUBLIC_SCREENS) {
      test(`RNF-06 RNF-05 ${screen.name} (${screen.path}) sin violaciones serias de axe en ${THEME_NAME[theme]}`, async ({
        page,
      }) => {
        await useTheme(page, theme);
        await page.goto(screen.path);
        await expectThemeApplied(page, theme);
        await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
        await page.waitForLoadState('networkidle');
        await expectNoBlockingViolations(page);
      });
    }

    test(`RNF-06 RNF-05 Revisa tu correo (/revisa-tu-correo) sin violaciones serias de axe en ${THEME_NAME[theme]}`, async ({
      page,
      mailbox,
    }) => {
      await useTheme(page, theme);
      await page.goto('/registro');
      await page.getByLabel(/nombre/i).fill('Ana Prueba');
      await page.getByLabel(/correo/i).fill(mailbox.newEmail());
      await page.getByLabel(/contraseña/i).fill(PASSWORD);
      await page.getByRole('checkbox').check();
      await page.getByRole('button', { name: /crear cuenta/i }).click();
      await expect(page).toHaveURL(/\/revisa-tu-correo/);
      await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
      await expectThemeApplied(page, theme);
      await expectNoBlockingViolations(page);
    });

    test(`RNF-06 RNF-05 Bienvenida, los 3 pasos del Onboarding (/bienvenida) sin violaciones serias de axe en ${THEME_NAME[theme]}`, async ({
      page,
      mailbox,
    }) => {
      await useTheme(page, theme);
      const email = mailbox.newEmail();
      await page.goto('/registro');
      await page.getByLabel(/nombre/i).fill('Ana Prueba');
      await page.getByLabel(/correo/i).fill(email);
      await page.getByLabel(/contraseña/i).fill(PASSWORD);
      await page.getByRole('checkbox').check();
      await page.getByRole('button', { name: /crear cuenta/i }).click();
      await page.goto(await mailbox.confirmationLink(email));
      await expect(page).toHaveURL(/\/bienvenida/);

      for (const step of [1, 2, 3]) {
        await expect(page.getByText(new RegExp(`Paso ${String(step)} de 3`)).first()).toBeVisible();
        await expectThemeApplied(page, theme);
        await page.waitForLoadState('networkidle');
        await expectNoBlockingViolations(page);
        if (step < 3) {
          await page.getByRole('button', { name: /continuar/i }).click();
        }
      }
    });

    for (const screen of AUTHED_SCREENS) {
      test(`RNF-06 RNF-05 ${screen.name} sin violaciones serias de axe en ${THEME_NAME[theme]}`, async ({
        authedPage,
      }) => {
        const world = await seedWorld(authedPage);
        await useTheme(authedPage, theme);
        await openAndCheck(authedPage, screen.path(world), theme);
      });
    }

    test(`RNF-06 RNF-05 Registrar con "Más opciones" y la lista "Ver todas" sin violaciones serias de axe en ${THEME_NAME[theme]}`, async ({
      authedPage,
    }) => {
      await seedWorld(authedPage);
      await useTheme(authedPage, theme);
      await authedPage.goto('/registrar');
      await expectThemeApplied(authedPage, theme);
      await settle(authedPage);

      await authedPage.getByRole('button', { name: /más opciones/i }).click();
      await expect(authedPage.getByLabel('Nota')).toBeVisible();
      await expectNoBlockingViolations(authedPage);

      await authedPage.getByRole('button', { name: 'Ver todas' }).click();
      await expect(authedPage.getByRole('dialog')).toBeVisible();
      await authedPage.waitForLoadState('networkidle');
      await expectNoBlockingViolations(authedPage);
    });

    test(`RNF-06 RNF-05 Movimientos con movimientos seleccionados sin violaciones serias de axe en ${THEME_NAME[theme]}`, async ({
      authedPage,
    }) => {
      await seedWorld(authedPage);
      await useTheme(authedPage, theme);
      await authedPage.goto('/movimientos');
      await expectThemeApplied(authedPage, theme);
      await settle(authedPage);

      // Space selects a movement on any width: the toolbar of the batch actions shows up.
      const row = authedPage.getByRole('link', { name: /Almuerzo/ }).first();
      await row.focus();
      await authedPage.keyboard.press('Space');
      await expect(
        authedPage.getByRole('region', { name: /acciones con los movimientos/i }),
      ).toBeVisible();
      await expectNoBlockingViolations(authedPage);
    });
  });
}
