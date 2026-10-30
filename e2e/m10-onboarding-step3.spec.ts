import type { Page } from '@playwright/test';

import { expect, test } from './fixtures/mailbox.js';
import type { MailboxFixtures } from './fixtures/mailbox.js';

type Mailbox = MailboxFixtures['mailbox'];
type Kind = 'expense' | 'income';

const PASSWORD = 'Contrasena-segura-1';
const TIMEZONE = 'America/La_Paz';
const BOLIVIA_OFFSET_MS = 4 * 60 * 60 * 1000;

/** The system category, present in both kinds (RF-M5-05, RF-M10-05). */
const SYSTEM_CATEGORY = 'Deudas y préstamos';

/** The button that sends a step; the last one finishes the Onboarding. */
const CONTINUE_BUTTON = /continuar|terminar|finalizar/i;

interface CategoryNode {
  id: string;
  kind: Kind;
  name: string;
  isSystem: boolean;
  status: string;
  children: CategoryNode[];
}

interface OnboardingBody {
  step: number;
  completed: boolean;
  presets: { accounts: unknown[]; categories: CategoryNode[] };
}

interface MeBody {
  onboarding: { step: number; completed: boolean };
}

/** Current month in Bolivia (UTC-4) as `YYYY-MM`. */
function currentMonth(): string {
  const now = new Date(Date.now() - BOLIVIA_OFFSET_MS);
  return `${String(now.getUTCFullYear())}-${String(now.getUTCMonth() + 1).padStart(2, '0')}`;
}

function flattenNames(nodes: CategoryNode[]): string[] {
  return nodes.flatMap((n) => [n.name, ...flattenNames(n.children)]);
}

async function getJson<T>(page: Page, path: string): Promise<T> {
  const res = await page.request.get(path);
  expect(res.status(), path).toBe(200);
  return (await res.json()) as T;
}

/** Names of the active categories of a kind, parents and subcategories. */
async function activeNames(page: Page, kind: Kind): Promise<string[]> {
  const tree = await getJson<CategoryNode[]>(page, `/api/categories?kind=${kind}&status=active`);
  return flattenNames(tree);
}

/** Names of the preset root categories of a kind that step 3 lets uncheck (not the system one). */
async function uncheckableRoots(page: Page, kind: Kind): Promise<string[]> {
  const body = await getJson<OnboardingBody>(page, '/api/onboarding');
  return body.presets.categories
    .filter((node) => node.kind === kind && !node.isSystem)
    .map((node) => node.name);
}

/** The checkbox of a category of the tree, by its name. */
function box(page: Page, name: string) {
  return page.getByRole('checkbox', { name, exact: true });
}

/**
 * A user just confirmed (spec §2.10.1): signs up, waits on "Revisa tu correo" and opens the
 * confirmation link in another tab; the waiting tab continues to the Onboarding (RF-M1-18).
 */
async function confirmedNewUser(page: Page, mailbox: Mailbox): Promise<string> {
  const email = mailbox.newEmail();
  await page.goto('/registro');
  await page.getByLabel(/nombre/i).fill('Ana Prueba');
  await page.getByLabel(/correo/i).fill(email);
  await page.getByLabel(/contraseña/i).fill(PASSWORD);
  await page.getByRole('checkbox').check();
  await page.getByRole('button', { name: /crear cuenta/i }).click();
  await expect(page).toHaveURL(/\/revisa-tu-correo/);
  const linkPage = await page.context().newPage();
  await linkPage.goto(await mailbox.confirmationLink(email));
  await expect(linkPage.getByText('Correo confirmado').first()).toBeVisible();
  await linkPage.close();
  await page.bringToFront();
  await expect(page).toHaveURL(/\/bienvenida/, { timeout: 20_000 });
  return email;
}

/** Confirms the user and moves on to step 2 with the base currency by default. */
async function userInStep2(page: Page, mailbox: Mailbox): Promise<string> {
  const email = await confirmedNewUser(page, mailbox);
  await expect(page.getByText(/Paso 1 de 3/).first()).toBeVisible();
  await page.getByRole('button', { name: /continuar/i }).click();
  await expect(page.getByText(/Paso 2 de 3/).first()).toBeVisible();
  return email;
}

/** Confirms the user and moves on to step 3 with the suggested accounts of step 2. */
async function userInStep3(page: Page, mailbox: Mailbox): Promise<void> {
  await userInStep2(page, mailbox);
  await page.getByRole('button', { name: /continuar/i }).click();
  await expect(page.getByText(/Paso 3 de 3/).first()).toBeVisible();
}

/** Sends step 3 and waits for the Onboarding to be finished. */
async function finishStep3(page: Page): Promise<void> {
  await page.getByRole('button', { name: CONTINUE_BUTTON }).click();
  const month = currentMonth();
  await expect(page).toHaveURL(
    (url) => url.pathname === '/' && (url.searchParams.get('mes') ?? month) === month,
  );
  await expect
    .poll(async () => (await getJson<MeBody>(page, '/api/me')).onboarding.completed)
    .toBe(true);
}

/** Unchecks every expense category that step 3 allows to uncheck. */
async function uncheckAllExpense(page: Page): Promise<void> {
  const roots = await uncheckableRoots(page, 'expense');
  expect(roots.length).toBeGreaterThan(0);
  for (const name of roots) {
    await box(page, name).uncheck();
  }
}

test.describe('TASK-162 Onboarding: paso 3 (categorías) y retomar', () => {
  test.use({ timezoneId: TIMEZONE });

  test('TASK-162 el paso 3 muestra el árbol con todas las casillas marcadas y "+ Agregar"', async ({
    page,
    mailbox,
  }) => {
    await userInStep3(page, mailbox);

    const body = await getJson<OnboardingBody>(page, '/api/onboarding');
    expect(body.step).toBe(3);
    const roots = body.presets.categories;
    expect(roots.length).toBeGreaterThan(0);

    const boxes = page.getByRole('checkbox');
    await expect.poll(async () => boxes.count()).toBeGreaterThanOrEqual(roots.length);
    for (const checkbox of await boxes.all()) {
      await expect(checkbox).toBeChecked();
    }
    await expect(box(page, 'Comida')).toBeVisible();
    await expect(box(page, 'Sueldo')).toBeVisible();
    await expect(page.getByRole('button', { name: /\+?\s*Agregar/ })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Saltar paso' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Saltar todo' })).toBeVisible();
  });

  test('TASK-162 desmarcar un padre desmarca sus subcategorías y no toca las demás', async ({
    page,
    mailbox,
  }) => {
    await userInStep3(page, mailbox);

    await box(page, 'Comida').uncheck();

    await expect(box(page, 'Comida')).not.toBeChecked();
    await expect(box(page, 'Supermercado')).not.toBeChecked();
    await expect(box(page, 'Restaurantes')).not.toBeChecked();
    await expect(box(page, 'Transporte')).toBeChecked();
    await expect(box(page, 'Micro/Trufi')).toBeChecked();
    await expect(box(page, 'Sueldo')).toBeChecked();
  });

  test('TASK-162 Continuar quita las desmarcadas, conserva las demás y termina en el Inicio', async ({
    page,
    mailbox,
  }) => {
    await userInStep3(page, mailbox);
    const incomeBefore = await activeNames(page, 'income');

    await box(page, 'Comida').uncheck();
    await box(page, 'Taxi/Apps').uncheck();
    await finishStep3(page);

    const expense = await activeNames(page, 'expense');
    for (const removed of ['Comida', 'Supermercado', 'Restaurantes', 'Taxi/Apps']) {
      expect(expense, removed).not.toContain(removed);
    }
    for (const kept of ['Transporte', 'Micro/Trufi', 'Combustible', 'Vivienda', SYSTEM_CATEGORY]) {
      expect(expense, kept).toContain(kept);
    }
    expect((await activeNames(page, 'income')).sort()).toEqual(incomeBefore.sort());
  });

  test('TASK-162 "+ Agregar" crea una categoría nueva al continuar', async ({ page, mailbox }) => {
    await userInStep3(page, mailbox);
    const name = 'Veterinaria';

    await page.getByRole('button', { name: /\+?\s*Agregar/ }).click();
    await page.getByLabel(/nombre/i).last().fill(name);
    // The short form may need its own confirmation before the step is sent.
    const confirm = page.getByRole('button', { name: /^(agregar|añadir|guardar|crear)( categoría)?$/i });
    if ((await confirm.count()) > 0) await confirm.first().click();
    await finishStep3(page);

    const all = [...(await activeNames(page, 'expense')), ...(await activeNames(page, 'income'))];
    expect(all).toContain(name);
    expect(all).toContain('Comida');
  });

  test('RF-M10-05 la casilla de "Deudas y préstamos" está marcada y no se puede desmarcar', async ({
    page,
    mailbox,
  }) => {
    await userInStep3(page, mailbox);

    const system = box(page, SYSTEM_CATEGORY);
    // It exists in expense and in income.
    await expect(system).toHaveCount(2);
    for (const checkbox of await system.all()) {
      await expect(checkbox).toBeChecked();
      await expect(checkbox).toBeDisabled();
      await checkbox.click({ force: true });
      await expect(checkbox).toBeChecked();
    }
  });

  test('RF-M10-05 desmarcar todo lo demás deja "Deudas y préstamos" en gasto e ingreso', async ({
    page,
    mailbox,
  }) => {
    await userInStep3(page, mailbox);
    await uncheckAllExpense(page);
    for (const name of await uncheckableRoots(page, 'income')) {
      await box(page, name).uncheck();
    }
    await expect(box(page, SYSTEM_CATEGORY).first()).toBeChecked();

    await finishStep3(page);

    for (const kind of ['expense', 'income'] as const) {
      const names = await activeNames(page, kind);
      expect(names, kind).toContain(SYSTEM_CATEGORY);
      expect(names, kind).toContain('Intereses');
    }
  });

  test('EC-M10-03 se pueden desmarcar todas las de gasto: el Onboarding termina y Registrar no ofrece las precargadas', async ({
    page,
    mailbox,
  }) => {
    await userInStep3(page, mailbox);
    const removed = await uncheckableRoots(page, 'expense');
    await uncheckAllExpense(page);

    await finishStep3(page);

    const names = await activeNames(page, 'expense');
    for (const name of removed) expect(names, name).not.toContain(name);
    expect(names).toContain(SYSTEM_CATEGORY);
    // The income categories stay as they were.
    expect(await activeNames(page, 'income')).toContain('Sueldo');

    await page.goto('/registrar');
    await page.getByRole('button', { name: 'Gasto', exact: true }).click();
    await page.getByRole('button', { name: 'Ver todas' }).click();
    const sheet = page.getByRole('dialog');
    await expect(sheet.getByRole('button', { name: SYSTEM_CATEGORY, exact: true })).toBeVisible();
    await expect(sheet.getByRole('button', { name: 'Comida', exact: true })).toHaveCount(0);
  });

  test('EC-M10-03 se pueden desmarcar todas las de ingreso y se termina el Onboarding', async ({
    page,
    mailbox,
  }) => {
    await userInStep3(page, mailbox);
    const removed = await uncheckableRoots(page, 'income');
    expect(removed.length).toBeGreaterThan(0);
    for (const name of removed) await box(page, name).uncheck();

    await finishStep3(page);

    const names = await activeNames(page, 'income');
    for (const name of removed) expect(names, name).not.toContain(name);
    expect(names).toContain(SYSTEM_CATEGORY);
    expect(await activeNames(page, 'expense')).toContain('Comida');
  });

  test('EC-M10-03 sin categorías de gasto, Registrar muestra "Crear categoría"', async ({
    page,
    mailbox,
  }) => {
    await userInStep3(page, mailbox);
    await uncheckAllExpense(page);
    await finishStep3(page);

    // The system category cannot be removed (RF-M10-05), so the list of the kind is served empty
    // here to reach the state the case describes: no category of the kind (EC-M7-07).
    await page.route(/\/api\/categories\?(?=.*kind=expense)/, async (route) => {
      if (route.request().method() !== 'GET') {
        await route.continue();
        return;
      }
      await route.fulfill({ json: [] });
    });
    await page.goto('/registrar');
    await page.getByRole('button', { name: 'Gasto', exact: true }).click();
    await page.getByRole('button', { name: 'Ver todas' }).click();

    await expect(page.getByRole('dialog').getByText(/no tienes categorías de gasto/i)).toBeVisible();
    await expect(page.getByRole('link', { name: 'Crear categoría' })).toBeVisible();
  });

  test('TASK-162 el borrador del paso 3 se conserva al recargar la página', async ({
    page,
    mailbox,
  }) => {
    await userInStep3(page, mailbox);

    await box(page, 'Comida').uncheck();
    // The draft is saved a moment after the last change.
    await expect
      .poll(async () =>
        page.evaluate(() => {
          const keys = [...Object.keys(localStorage), ...Object.keys(sessionStorage)];
          return keys.some((key) => key.includes('onboarding-step3'));
        }),
      )
      .toBe(true);

    await page.reload();

    await expect(page.getByText(/Paso 3 de 3/).first()).toBeVisible();
    await expect(box(page, 'Comida')).not.toBeChecked();
    await expect(box(page, 'Supermercado')).not.toBeChecked();
    await expect(box(page, 'Transporte')).toBeChecked();
  });

  test('RF-M10-01 Retomar en otro dispositivo: con el paso 1 completado, otro contexto abre en el paso 2', async ({
    page,
    browser,
    baseURL,
    mailbox,
  }) => {
    const email = await userInStep2(page, mailbox);

    const other = await browser.newContext({
      baseURL,
      timezoneId: TIMEZONE,
      viewport: page.viewportSize() ?? undefined,
    });
    try {
      const computer = await other.newPage();
      await computer.goto('/entrar');
      await computer.getByLabel(/correo/i).fill(email);
      await computer.getByLabel(/contraseña/i).fill(PASSWORD);
      await computer.getByRole('button', { name: /entrar|iniciar sesión/i }).click();

      await expect(computer).toHaveURL(/\/bienvenida/);
      await expect(computer.getByText(/Paso 2 de 3/).first()).toBeVisible();
      await expect(computer.getByText(/Paso 1 de 3/)).toHaveCount(0);
    } finally {
      await other.close();
    }
  });

  test('RF-M10-01 con el paso 2 completado, otro contexto abre en el paso 3 sin repreguntar', async ({
    page,
    browser,
    baseURL,
    mailbox,
  }) => {
    const email = await userInStep2(page, mailbox);
    await page.getByRole('button', { name: /continuar/i }).click();
    await expect(page.getByText(/Paso 3 de 3/).first()).toBeVisible();

    const other = await browser.newContext({
      baseURL,
      timezoneId: TIMEZONE,
      viewport: page.viewportSize() ?? undefined,
    });
    try {
      const computer = await other.newPage();
      await computer.goto('/entrar');
      await computer.getByLabel(/correo/i).fill(email);
      await computer.getByLabel(/contraseña/i).fill(PASSWORD);
      await computer.getByRole('button', { name: /entrar|iniciar sesión/i }).click();

      await expect(computer).toHaveURL(/\/bienvenida/);
      await expect(computer.getByText(/Paso 3 de 3/).first()).toBeVisible();
      await expect(computer.getByText(/Paso (1|2) de 3/)).toHaveCount(0);
      await expect(box(computer, 'Comida')).toBeChecked();
    } finally {
      await other.close();
    }
  });
});
