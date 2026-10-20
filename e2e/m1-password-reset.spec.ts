import { expect, test } from './fixtures/auth.js';

import type { Page } from '@playwright/test';

const NEW_PASSWORD = 'Contrasena-nueva-7';

async function requestLink(page: Page, email: string): Promise<void> {
  await page.goto('/olvide-mi-contrasena');
  await page.getByLabel(/correo/i).fill(email);
  await page.getByRole('button', { name: /enviar|recuperar|restablecer/i }).click();
}

async function resetLink(
  mailbox: { inboxOf: (to: string) => Promise<{ kind: string; payload: { link?: string } }[]> },
  email: string,
  count: number,
): Promise<string> {
  await expect
    .poll(async () => (await mailbox.inboxOf(email)).filter((e) => e.kind === 'reset').length, {
      timeout: 15_000,
    })
    .toBeGreaterThanOrEqual(count);
  const link = (await mailbox.inboxOf(email)).filter((e) => e.kind === 'reset')[count - 1]?.payload
    .link;
  if (link === undefined) {
    throw new Error(`No reset link for ${email}`);
  }
  return link;
}

async function setNewPassword(page: Page, link: string, password: string): Promise<void> {
  await page.goto(link);
  await page.getByLabel(/contraseña/i).first().fill(password);
  await page.getByRole('button', { name: /guardar|restablecer|cambiar|actualizar/i }).click();
}

test.describe('TASK-067 recuperar la contraseña', () => {
  test('RNF-15 pedir el enlace muestra el mismo mensaje con o sin cuenta', async ({
    page,
    testUser,
    mailbox,
  }) => {
    await requestLink(page, testUser.email);
    const known = page.getByText(/si el correo|si existe|te enviamos|revisa tu correo/i).first();
    await expect(known).toBeVisible();
    const knownText = await known.innerText();

    await requestLink(page, mailbox.newEmail());
    const unknown = page.getByText(/si el correo|si existe|te enviamos|revisa tu correo/i).first();
    await expect(unknown).toBeVisible();
    expect(await unknown.innerText()).toBe(knownText);
    await expect(page.getByText(/no existe|no está registrado|no tiene cuenta/i)).toHaveCount(0);
  });

  test('RF-M1-09 el enlace restablece la contraseña, abre sesión y navega a la app', async ({
    page,
    testUser,
    mailbox,
  }) => {
    await requestLink(page, testUser.email);
    const link = await resetLink(mailbox, testUser.email, 1);
    await setNewPassword(page, link, NEW_PASSWORD);
    await expect(page).not.toHaveURL(/\/(restablecer|entrar|olvide-mi-contrasena)/);
    await page.goto('/perfil');
    await expect(page).toHaveURL(/\/perfil/);
  });

  test('RF-M1-09 reabrir el mismo enlace muestra que ya no es válido', async ({
    page,
    testUser,
    mailbox,
  }) => {
    await requestLink(page, testUser.email);
    const link = await resetLink(mailbox, testUser.email, 1);
    await setNewPassword(page, link, NEW_PASSWORD);
    await expect(page).not.toHaveURL(/\/restablecer/);

    await page.context().clearCookies();
    await page.goto(link);
    await expect(page.getByText(/enlace.*(no es válido|venci|usad)|ya no es válido/i).first()).toBeVisible();
  });

  test('RF-M1-09 pedir un enlace nuevo invalida el anterior', async ({
    page,
    testUser,
    mailbox,
  }) => {
    await requestLink(page, testUser.email);
    const first = await resetLink(mailbox, testUser.email, 1);
    await requestLink(page, testUser.email);
    await resetLink(mailbox, testUser.email, 2);

    await page.goto(first);
    await expect(page.getByText(/enlace.*(no es válido|venci|usad)|ya no es válido/i).first()).toBeVisible();
  });

  test('RF-M1-10 tras restablecer, otro contexto con sesión previa la pierde en su siguiente acción', async ({
    page,
    browser,
    testUser,
    mailbox,
  }) => {
    const other = await browser.newContext();
    const otherPage = await other.newPage();
    await otherPage.goto('/entrar');
    await otherPage.getByLabel(/correo/i).fill(testUser.email);
    await otherPage.getByLabel(/contraseña/i).fill(testUser.password);
    await otherPage.getByRole('button', { name: /entrar|iniciar sesión/i }).click();
    await expect(otherPage).not.toHaveURL(/\/entrar/);

    await requestLink(page, testUser.email);
    const link = await resetLink(mailbox, testUser.email, 1);
    await setNewPassword(page, link, NEW_PASSWORD);
    await expect(page).not.toHaveURL(/\/restablecer/);

    await otherPage.goto('/perfil');
    await expect(otherPage).toHaveURL(/\/entrar/);
    await other.close();

    await expect
      .poll(
        async () =>
          (await mailbox.inboxOf(testUser.email)).filter((e) => e.kind === 'password_changed')
            .length,
        { timeout: 15_000 },
      )
      .toBeGreaterThanOrEqual(1);
  });
});
