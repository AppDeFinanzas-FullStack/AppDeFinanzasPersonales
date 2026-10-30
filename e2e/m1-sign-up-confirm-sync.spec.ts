import { expect, test } from './fixtures/auth.js';

import type { Browser, BrowserContext, Page } from '@playwright/test';

/**
 * TASK-266 (RF-M1-18, EC-M1-11, EC-M1-13; plan §4.1.4): the confirmation link only confirms the
 * account, and the app that waits on "Revisa tu correo" opens the session and continues to the
 * Onboarding by itself.
 */

const PASSWORD = 'Contrasena-segura-1';
const SESSION_COOKIE = '__Secure-better-auth.session_token';

/** Time the waiting tab may take to notice the confirmation (it asks every 3 s). */
const WATCH_TIMEOUT = 20_000;

interface MeBody {
  email: string;
}

async function signUpAndWait(page: Page, email: string): Promise<void> {
  await page.goto('/registro');
  await page.getByLabel(/nombre/i).fill('Ana Prueba');
  await page.getByLabel(/correo/i).fill(email);
  await page.getByLabel(/contraseña/i).fill(PASSWORD);
  await page.getByRole('checkbox').check();
  await page.getByRole('button', { name: /crear cuenta|registrarme|registrarse/i }).click();
  await expect(page).toHaveURL(/\/revisa-tu-correo/);
}

/** Opens the link and checks the page only says the account is confirmed. */
async function openLink(page: Page, link: string): Promise<void> {
  await page.goto(link);
  await expect(page.getByText('Correo confirmado').first()).toBeVisible();
  await expect(page.getByText(/vuelve a la app donde creaste tu cuenta/i)).toBeVisible();
  await expect(page).toHaveURL(/\/confirmar/);
}

async function meEmail(page: Page): Promise<string> {
  const res = await page.request.get('/api/me');
  expect(res.status()).toBe(200);
  return ((await res.json()) as MeBody).email;
}

/** A second browser (another device): its own cookies, same viewport. */
async function otherContext(
  page: Page,
  browser: Browser,
  baseURL: string | undefined,
): Promise<BrowserContext> {
  return browser.newContext({ baseURL, viewport: page.viewportSize() ?? undefined });
}

test.describe('TASK-266 la app que espera continúa sola al Onboarding', () => {
  test('RF-M1-18 La pestaña de registro continúa sola al confirmar el correo (otro dispositivo)', async ({
    page,
    browser,
    baseURL,
    mailbox,
  }) => {
    const email = mailbox.newEmail();
    await signUpAndWait(page, email);
    const link = await mailbox.confirmationLink(email);

    const phone = await otherContext(page, browser, baseURL);
    try {
      const linkPage = await phone.newPage();
      await openLink(linkPage, link);
      // The link page has no session: only the waiting app opens it.
      expect((await linkPage.request.get('/api/me')).status()).toBe(401);

      await expect(page).toHaveURL(/\/bienvenida/, { timeout: WATCH_TIMEOUT });
      await expect(page.getByText(/Paso 1 de 3/).first()).toBeVisible();
      expect(await meEmail(page)).toBe(email);

      await expect(linkPage).toHaveURL(/\/confirmar/);
      expect((await linkPage.request.get('/api/me')).status()).toBe(401);
    } finally {
      await phone.close();
    }
  });

  test('RF-M1-18 con las dos pestañas en el mismo navegador, la de registro continúa sola', async ({
    page,
    mailbox,
  }) => {
    const email = mailbox.newEmail();
    await signUpAndWait(page, email);
    const link = await mailbox.confirmationLink(email);

    const linkPage = await page.context().newPage();
    await openLink(linkPage, link);
    await expect(linkPage).not.toHaveURL(/\/bienvenida/);

    await page.bringToFront();
    await expect(page).toHaveURL(/\/bienvenida/, { timeout: WATCH_TIMEOUT });
    await expect(page.getByText(/Paso 1 de 3/).first()).toBeVisible();
    expect(await meEmail(page)).toBe(email);
    await expect(linkPage.getByText('Correo confirmado').first()).toBeVisible();
  });

  test('EC-M1-13 con la app del registro cerrada, el enlace dice "Correo confirmado" y el usuario inicia sesión', async ({
    page,
    browser,
    baseURL,
    mailbox,
  }) => {
    const email = mailbox.newEmail();
    const signUpContext = await otherContext(page, browser, baseURL);
    try {
      await signUpAndWait(await signUpContext.newPage(), email);
    } finally {
      await signUpContext.close();
    }
    const link = await mailbox.confirmationLink(email);

    await openLink(page, link);
    // Nothing continues by itself: the page stays and there is no session.
    await page.waitForTimeout(4_000);
    await expect(page).toHaveURL(/\/confirmar/);
    expect((await page.request.get('/api/me')).status()).toBe(401);

    await page.getByRole('link', { name: /inicia(r)? sesión/i }).click();
    await expect(page).toHaveURL(/\/entrar/);
    await page.getByLabel(/correo/i).fill(email);
    await page.getByLabel(/contraseña/i).fill(PASSWORD);
    await page.getByRole('button', { name: /entrar|iniciar sesión/i }).click();
    await expect(page).toHaveURL(/\/bienvenida/);
    expect(await meEmail(page)).toBe(email);
  });

  test('EC-M1-11 confirmar con la sesión de otro usuario abierta en el navegador que espera la cierra y deja la del confirmado', async ({
    page,
    browser,
    baseURL,
    mailbox,
    testUser,
    request,
  }) => {
    const email = mailbox.newEmail();
    await signUpAndWait(page, email);

    // Another user (B) signs in on the same browser while the tab waits for A.
    const signIn = await page.request.post('/api/auth/sign-in', {
      data: { email: testUser.email, password: testUser.password },
    });
    expect(signIn.status()).toBe(200);
    expect(await meEmail(page)).toBe(testUser.email);
    const sessionOfB = (await page.context().cookies()).find((c) => c.name === SESSION_COOKIE);
    expect(sessionOfB).toBeDefined();
    await expect(page).toHaveURL(/\/revisa-tu-correo/);

    const link = await mailbox.confirmationLink(email);
    const phone = await otherContext(page, browser, baseURL);
    try {
      await openLink(await phone.newPage(), link);
    } finally {
      await phone.close();
    }

    await expect(page).toHaveURL(/\/bienvenida/, { timeout: WATCH_TIMEOUT });
    expect(await meEmail(page)).toBe(email);
    const oldSession = await request.get('/api/me', {
      headers: { cookie: `${SESSION_COOKIE}=${sessionOfB?.value ?? ''}` },
    });
    expect(oldSession.status()).toBe(401);
  });
});
