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
