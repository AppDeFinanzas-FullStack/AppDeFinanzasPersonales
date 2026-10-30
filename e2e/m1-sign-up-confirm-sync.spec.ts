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

/**
 * TASK-273 (EC-M1-11, EC-M2-01; plan §4.1.4): when the waiting app continues as A, the drafts the
 * previous user (B) left in that browser are discarded.
 */

const DRAFT_NAME = 'Borrador de B sin guardar';

interface MeWithId {
  id: string;
  name: string;
  email: string;
}

async function readMe(page: Page): Promise<MeWithId> {
  const res = await page.request.get('/api/me');
  expect(res.status()).toBe(200);
  return (await res.json()) as MeWithId;
}

/** Keys of the drafts kept for a user (plan §4.2.3: `draft:{userId}:{formKey}`). */
async function draftKeysOf(page: Page, userId: string): Promise<string[]> {
  return page.evaluate((prefix) => {
    const keys: string[] = [];
    for (let index = 0; index < sessionStorage.length; index += 1) {
      const key = sessionStorage.key(index);
      if (key?.startsWith(prefix) === true) keys.push(key);
    }
    return keys;
  }, `draft:${userId}:`);
}

/** Leaves an unsaved profile name of `userId` as a draft in this tab (plan §4.2.3). */
async function leaveProfileDraft(page: Page, userId: string): Promise<void> {
  await page.evaluate(
    ([key, value]) => {
      sessionStorage.setItem(key, value);
    },
    [`draft:${userId}:profile`, JSON.stringify({ name: DRAFT_NAME })] as const,
  );
  expect(await draftKeysOf(page, userId)).toEqual([`draft:${userId}:profile`]);
}

async function confirmFromPhone(
  page: Page,
  browser: Browser,
  baseURL: string | undefined,
  link: string,
): Promise<void> {
  const phone = await otherContext(page, browser, baseURL);
  try {
    await openLink(await phone.newPage(), link);
  } finally {
    await phone.close();
  }
}

test.describe('TASK-273 la confirmación descarta los borradores de la sesión anterior', () => {
  test('EC-M1-11 EC-M2-01 el borrador de B se descarta al continuar como A y B vuelve a un formulario sin él', async ({
    page,
    browser,
    baseURL,
    mailbox,
    testUser,
  }) => {
    const email = mailbox.newEmail();
    await signUpAndWait(page, email);

    // B signs in on the same browser while the tab waits for A, and leaves a draft there.
    const signIn = await page.request.post('/api/auth/sign-in', {
      data: { email: testUser.email, password: testUser.password },
    });
    expect(signIn.status()).toBe(200);
    const userB = await readMe(page);
    expect(userB.email).toBe(testUser.email);
    await leaveProfileDraft(page, userB.id);
    await expect(page).toHaveURL(/\/revisa-tu-correo/);

    await confirmFromPhone(page, browser, baseURL, await mailbox.confirmationLink(email));

    await expect(page).toHaveURL(/\/bienvenida/, { timeout: WATCH_TIMEOUT });
    const userA = await readMe(page);
    expect(userA.email).toBe(email);
    expect(userA.id).not.toBe(userB.id);
    await expect.poll(async () => draftKeysOf(page, userB.id)).toEqual([]);

    // B signs in again on this browser: the profile form shows no trace of the old draft.
    const again = await page.request.post('/api/auth/sign-in', {
      data: { email: testUser.email, password: testUser.password },
    });
    expect(again.status()).toBe(200);
    expect((await readMe(page)).id).toBe(userB.id);
    await page.goto('/perfil');
    await expect(page).toHaveURL(/\/perfil/);
    const nameField = page.getByLabel(/^nombre/i).first();
    await expect(nameField).toHaveValue(userB.name);
    await expect(nameField).not.toHaveValue(DRAFT_NAME);
  });

  test('RF-M1-18 sin otra sesión abierta la confirmación sigue llevando a /bienvenida', async ({
    page,
    browser,
    baseURL,
    mailbox,
  }) => {
    const email = mailbox.newEmail();
    await signUpAndWait(page, email);
    expect((await page.request.get('/api/me')).status()).toBe(401);

    await confirmFromPhone(page, browser, baseURL, await mailbox.confirmationLink(email));

    await expect(page).toHaveURL(/\/bienvenida/, { timeout: WATCH_TIMEOUT });
    await expect(page.getByText(/Paso 1 de 3/).first()).toBeVisible();
    expect((await readMe(page)).email).toBe(email);
  });
});
