import { expect, test } from './fixtures/auth.js';
import type { TestUser } from './fixtures/auth.js';

import type { Browser, BrowserContext, Page } from '@playwright/test';

const NEW_PASSWORD = 'Contrasena-nueva-7';
const NEW_TIMEZONE = 'America/Lima';
const NEW_NAME = 'Nombre editado';

interface Me {
  name: string;
  email: string;
  timezone: string;
}

/** Opens a second, independent browser context signed in as the same user (device B). */
async function signInElsewhere(
  browser: Browser,
  user: TestUser,
): Promise<{ context: BrowserContext; page: Page }> {
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.goto('/entrar');
  await page.getByLabel(/correo/i).fill(user.email);
  await page.getByLabel(/contraseña/i).fill(user.password);
  await page.getByRole('button', { name: /entrar|iniciar sesión/i }).click();
  await expect(page).not.toHaveURL(/\/entrar/);
  return { context, page };
}

async function readMe(page: Page): Promise<Me> {
  const res = await page.request.get('/api/me');
  expect(res.status()).toBe(200);
  return (await res.json()) as Me;
}

async function chooseTimezone(page: Page, timezone: string): Promise<void> {
  const field = page.getByLabel(/zona horaria/i).first();
  const tag = await field.evaluate((el) => el.tagName);
  if (tag === 'SELECT') {
    await field.selectOption(timezone);
    return;
  }
  if (tag === 'INPUT') {
    await field.fill(timezone);
  } else {
    await field.click();
    await page.keyboard.type(timezone);
  }
  const option = page.getByRole('option', { name: new RegExp(timezone.replace('/', '.'), 'i') });
  await option.first().click();
}

function saveProfileButton(page: Page) {
  return page.getByRole('button', { name: /^guardar( cambios)?$/i });
}

async function changePassword(page: Page, current: string, next: string): Promise<void> {
  await page.getByLabel(/contraseña actual/i).fill(current);
  await page.getByLabel(/contraseña nueva|nueva contraseña/i).first().fill(next);
  await page
    .getByRole('button', { name: /(cambiar|actualizar|guardar) (la )?contraseña/i })
    .click();
}

test.describe('TASK-074 pantalla de perfil', () => {
  test('RF-M1-13 el correo se muestra sin poder editarse y con su explicación', async ({
    authedPage,
    testUser,
  }) => {
    await authedPage.goto('/perfil');
    await expect(authedPage).toHaveURL(/\/perfil/);

    const shown = authedPage
      .getByText(testUser.email)
      .or(authedPage.locator(`input[value="${testUser.email}"]`));
    await expect(shown.first()).toBeVisible();

    const editable = authedPage.locator(`input[value="${testUser.email}"]:not([readonly]):not([disabled])`);
    await expect(editable).toHaveCount(0);
    const emailFields = authedPage.getByRole('textbox', { name: /correo/i });
    for (const field of await emailFields.all()) {
      await expect(field).not.toBeEditable();
    }

    await expect(authedPage.getByText(/export.*elimin.*registr/i).first()).toBeVisible();
  });

  test('RF-M1-13 la API rechaza cambiar el correo desde el perfil', async ({
    authedPage,
    testUser,
  }) => {
    await authedPage.goto('/perfil');
    const res = await authedPage.request.patch('/api/me', {
      data: { email: 'otro-correo@example.com' },
    });
    expect(res.status()).toBe(400);
    expect((await readMe(authedPage)).email).toBe(testUser.email);
  });

  test('TASK-074 el idioma es fijo en Español (Bolivia)', async ({ authedPage }) => {
    await authedPage.goto('/perfil');
    await expect(authedPage.getByText(/español \(bolivia\)/i).first()).toBeVisible();
  });

  test('TASK-074 el cambio de nombre se guarda', async ({ authedPage }) => {
    await authedPage.goto('/perfil');
    await authedPage.getByLabel(/^nombre/i).first().fill(NEW_NAME);
    await saveProfileButton(authedPage).click();

    await expect.poll(async () => (await readMe(authedPage)).name).toBe(NEW_NAME);
    await authedPage.reload();
    await expect(authedPage.getByLabel(/^nombre/i).first()).toHaveValue(NEW_NAME);
  });

  test('RF-M1-11 el cambio de zona horaria se guarda', async ({ authedPage }) => {
    await authedPage.goto('/perfil');
    expect((await readMe(authedPage)).timezone).not.toBe(NEW_TIMEZONE);

    await chooseTimezone(authedPage, NEW_TIMEZONE);
    await saveProfileButton(authedPage).click();

    await expect.poll(async () => (await readMe(authedPage)).timezone).toBe(NEW_TIMEZONE);
    await authedPage.reload();
    await expect(authedPage).toHaveURL(/\/perfil/);
    expect((await readMe(authedPage)).timezone).toBe(NEW_TIMEZONE);
  });

  test('EC-M1-05 tras cambiar la contraseña en A, B pierde la sesión en su siguiente acción', async ({
    authedPage,
    browser,
    testUser,
  }) => {
    const other = await signInElsewhere(browser, testUser);
    await other.page.goto('/perfil');
    await expect(other.page).toHaveURL(/\/perfil/);

    await authedPage.goto('/perfil');
    await changePassword(authedPage, testUser.password, NEW_PASSWORD);

    await expect
      .poll(async () => (await authedPage.request.get('/api/me')).status(), { timeout: 15_000 })
      .toBe(200);
    await expect
      .poll(async () => (await other.page.request.get('/api/me')).status(), { timeout: 15_000 })
      .toBe(401);

    await other.page.reload();
    await expect(other.page).toHaveURL(/\/entrar/);
    await other.context.close();

    await authedPage.reload();
    await expect(authedPage).toHaveURL(/\/perfil/);
  });

  test('RF-M1-10 cambiar la contraseña desde el perfil envía el correo de aviso', async ({
    authedPage,
    testUser,
    mailbox,
  }) => {
    await authedPage.goto('/perfil');
    await changePassword(authedPage, testUser.password, NEW_PASSWORD);

    await expect
      .poll(
        async () =>
          (await mailbox.inboxOf(testUser.email)).filter((e) => e.kind === 'password_changed')
            .length,
        { timeout: 15_000 },
      )
      .toBeGreaterThanOrEqual(1);
  });

  test('RF-M1-07 Cerrar sesión cierra solo el dispositivo actual', async ({
    authedPage,
    browser,
    testUser,
  }) => {
    const other = await signInElsewhere(browser, testUser);

    await authedPage.goto('/perfil');
    await authedPage.getByRole('button', { name: /^cerrar sesión$/i }).click();
    await expect(authedPage).toHaveURL(/\/entrar/);

    await other.page.goto('/perfil');
    await expect(other.page).toHaveURL(/\/perfil/);
    await other.context.close();
  });

  test('RF-M1-07 Cerrar sesión en todos los dispositivos cierra el otro contexto', async ({
    authedPage,
    browser,
    testUser,
  }) => {
    const other = await signInElsewhere(browser, testUser);
    await other.page.goto('/perfil');
    await expect(other.page).toHaveURL(/\/perfil/);

    await authedPage.goto('/perfil');
    await authedPage
      .getByRole('button', { name: /cerrar sesión en todos los dispositivos/i })
      .click();

    await expect
      .poll(async () => (await other.page.request.get('/api/me')).status(), { timeout: 15_000 })
      .toBe(401);
    await other.page.reload();
    await expect(other.page).toHaveURL(/\/entrar/);
    await other.context.close();

    await authedPage.goto('/perfil');
    await expect(authedPage).toHaveURL(/\/entrar/);
  });
});
