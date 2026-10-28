import { expect, test } from './fixtures/auth.js';

import type { Page } from '@playwright/test';

const WRONG = 'Correo o contraseña incorrectos';

async function signIn(page: Page, email: string, password: string): Promise<void> {
  await page.goto('/entrar');
  await page.getByLabel(/correo/i).fill(email);
  await page.getByLabel(/contraseña/i).fill(password);
  await page.getByRole('button', { name: /entrar|iniciar sesión/i }).click();
}

test.describe('TASK-066 inicio de sesión', () => {
  test('TASK-066 el fixture authedPage deja una sesión abierta fuera de /entrar', async ({
    authedPage,
  }) => {
    await expect(authedPage).not.toHaveURL(/\/entrar/);
  });

  test('RNF-15 una contraseña incorrecta muestra el mensaje genérico', async ({
    page,
    testUser,
  }) => {
    await signIn(page, testUser.email, 'Contrasena-equivocada-9');
    await expect(page.getByText(WRONG)).toBeVisible();
    await expect(page).toHaveURL(/\/entrar/);
  });

  test('RNF-15 un correo sin cuenta muestra el mismo mensaje, sin decir cuál dato falló', async ({
    page,
    mailbox,
  }) => {
    await signIn(page, mailbox.newEmail(), 'Contrasena-equivocada-9');
    await expect(page.getByText(WRONG)).toBeVisible();
    await expect(page.getByText(/no existe|no está registrado|contraseña es incorrecta/i)).toHaveCount(0);
  });

  test('RF-M1-04 un usuario sin confirmar ve "Revisa tu correo" y no abre sesión', async ({
    page,
    mailbox,
  }) => {
    const email = mailbox.newEmail();
    const password = 'Contrasena-segura-1';
    await page.goto('/registro');
    await page.getByLabel(/nombre/i).fill('Ana Prueba');
    await page.getByLabel(/correo/i).fill(email);
    await page.getByLabel(/contraseña/i).fill(password);
    await page.getByRole('checkbox').check();
    await page.getByRole('button', { name: /crear cuenta|registrarme|registrarse/i }).click();
    await expect(page).toHaveURL(/\/revisa-tu-correo/);

    await signIn(page, email, password);
    await expect(page).toHaveURL(/\/revisa-tu-correo/);
    await expect(page.getByText(/revisa tu correo/i).first()).toBeVisible();
    await page.goto('/perfil');
    await expect(page).toHaveURL(/\/entrar/);
  });

  test('EC-M1-04 tras 5 fallos se ve el tiempo restante, aun con la contraseña correcta', async ({
    page,
    testUser,
  }) => {
    for (let i = 0; i < 5; i += 1) {
      await signIn(page, testUser.email, 'Contrasena-equivocada-9');
      await expect(page.getByText(/correo o contraseña incorrectos|esper/i).first()).toBeVisible();
    }
    await signIn(page, testUser.email, testUser.password);
    await expect(page).toHaveURL(/\/entrar/);
    await expect(page.getByText(/(\d+\s*(s|seg|segundos?|minutos?))\b|\b\d{1,2}:\d{2}\b/i)).toBeVisible();
  });

  test('RF-M1-08 la cuenta regresiva baja con el tiempo', async ({ page, testUser }) => {
    await page.clock.install();
    for (let i = 0; i < 5; i += 1) {
      await signIn(page, testUser.email, 'Contrasena-equivocada-9');
      await expect(page.getByText(/correo o contraseña incorrectos|esper/i).first()).toBeVisible();
    }
    await signIn(page, testUser.email, testUser.password);
    const countdown = page.getByText(/(\d+\s*(s|seg|segundos?|minutos?))\b|\b\d{1,2}:\d{2}\b/i);
    await expect(countdown).toBeVisible();
    const before = await countdown.innerText();
    await page.clock.fastForward(10_000);
    await expect(countdown).not.toHaveText(before);
  });
});

function sessionExpiredDialog(page: Page) {
  return page
    .getByRole('dialog')
    .or(page.getByRole('alertdialog'))
    .filter({ hasText: /tu sesión venció/i });
}

test.describe('TASK-253 iniciar sesión desde /entrar en un contexto nuevo', () => {
  test.use({ colorScheme: 'light' });

  test('RF-M2-09 EC-M2-01 llega a / sin «Tu sesión venció», usable y con el tema del servidor', async ({
    browser,
    page,
    testUser,
  }) => {
    // The server keeps the dark theme, saved from another browser.
    const setup = await browser.newContext({ baseURL: test.info().project.use.baseURL });
    const setupPage = await setup.newPage();
    await signIn(setupPage, testUser.email, testUser.password);
    await expect(setupPage).not.toHaveURL(/\/entrar/);
    const saved = await setupPage.request.patch('/api/settings', { data: { theme: 'dark' } });
    expect(saved.ok()).toBe(true);
    await setup.close();

    // A new context, with no session and no localStorage copy of the theme.
    await signIn(page, testUser.email, testUser.password);
    await expect(page).toHaveURL(/\/$/);

    // EC-M2-01: the theme saved on the server applies after signing in.
    await expect(page.locator('html')).toHaveClass(/\bdark\b/);

    // RF-M2-09: no session-expired dialog covers the screen and it can be used.
    await page.waitForLoadState('networkidle');
    await expect(sessionExpiredDialog(page)).toHaveCount(0);
    await page
      .getByRole('link', { name: /^movimientos$/i })
      .locator('visible=true')
      .first()
      .click({ timeout: 5_000 });
    await expect(page).toHaveURL(/\/movimientos/);
    await expect(sessionExpiredDialog(page)).toHaveCount(0);
  });
});
