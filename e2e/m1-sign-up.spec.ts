import { expect, test } from './fixtures/mailbox.js';

import type { Page } from '@playwright/test';

const PASSWORD = 'Contrasena-segura-1';

async function fillSignUp(page: Page, email: string): Promise<void> {
  await page.goto('/registro');
  await page.getByLabel(/nombre/i).fill('Ana Prueba');
  await page.getByLabel(/correo/i).fill(email);
  await page.getByLabel(/contraseña/i).fill(PASSWORD);
  await page.getByRole('checkbox').check();
  await page.getByRole('button', { name: /crear cuenta|registrarme|registrarse/i }).click();
}

test.describe('TASK-065 registro, revisa tu correo y confirmación', () => {
  test('RF-M1-03 el registro muestra el mensaje neutro y lleva a "Revisa tu correo"', async ({
    page,
    mailbox,
  }) => {
    const email = mailbox.newEmail();
    await fillSignUp(page, email);
    await expect(page).toHaveURL(/\/revisa-tu-correo/);
    await expect(page.getByText(/revisa tu correo/i).first()).toBeVisible();
    await mailbox.confirmationLink(email);
  });

  test('RF-M1-03 un correo ya registrado recibe el mismo mensaje neutro', async ({
    page,
    mailbox,
  }) => {
    const email = mailbox.newEmail();
    await fillSignUp(page, email);
    await expect(page).toHaveURL(/\/revisa-tu-correo/);
    await fillSignUp(page, email);
    await expect(page).toHaveURL(/\/revisa-tu-correo/);
  });

  test('RF-M1-01 el formulario exige los términos y una contraseña de 8 caracteres', async ({
    page,
  }) => {
    await page.goto('/registro');
    await page.getByLabel(/nombre/i).fill('Ana Prueba');
    await page.getByLabel(/correo/i).fill('ana@example.com');
    await page.getByLabel(/contraseña/i).fill('corta');
    await page.getByRole('button', { name: /crear cuenta|registrarme|registrarse/i }).click();
    await expect(page).toHaveURL(/\/registro/);
    await expect(page.getByRole('checkbox')).not.toBeChecked();
  });

  test.describe('zona horaria del dispositivo', () => {
    test.use({ timezoneId: 'America/Santiago' });

    test('RF-M1-11 el usuario creado tiene la zona horaria del navegador', async ({
      page,
      mailbox,
    }) => {
      const email = mailbox.newEmail();
      await fillSignUp(page, email);
      await expect(page).toHaveURL(/\/revisa-tu-correo/);
      await page.goto(await mailbox.confirmationLink(email));
      await expect(page).toHaveURL(/\/bienvenida/);
      const res = await page.request.post('/api/auth/sign-in', {
        data: { email, password: PASSWORD },
      });
      expect(res.status()).toBe(200);
      const body = (await res.json()) as { me: { timezone: string } };
      expect(body.me.timezone).toBe('America/Santiago');
    });
  });

  test('RF-M1-05 el reenvío queda deshabilitado durante 60 s', async ({ page, mailbox }) => {
    await page.clock.install();
    const email = mailbox.newEmail();
    await fillSignUp(page, email);
    await expect(page).toHaveURL(/\/revisa-tu-correo/);
    const resend = page.getByRole('button', { name: /reenviar/i });
    await expect(resend).toBeDisabled();
    await page.clock.fastForward(30_000);
    await expect(resend).toBeDisabled();
    await page.clock.fastForward(31_000);
    await expect(resend).toBeEnabled();
    await resend.click();
    await mailbox.confirmationLink(email, 2);
    await expect(resend).toBeDisabled();
  });

  test('RF-M1-05 el reenvío invalida el enlace anterior (EC-M1-01)', async ({ page, mailbox }) => {
    await page.clock.install();
    const email = mailbox.newEmail();
    await fillSignUp(page, email);
    const first = await mailbox.confirmationLink(email);
    await page.clock.fastForward(61_000);
    await page.getByRole('button', { name: /reenviar/i }).click();
    await mailbox.confirmationLink(email, 2);
    await page.goto(first);
    await expect(page.getByText('Este enlace ya no es válido')).toBeVisible();
  });

  test('EC-M1-01 un enlace inválido muestra "Este enlace ya no es válido" y ofrece reenviar', async ({
    page,
  }) => {
    await page.goto(`/confirmar?token=${'x'.repeat(43)}`);
    await expect(page.getByText('Este enlace ya no es válido')).toBeVisible();
    await expect(page.getByRole('button', { name: /reenviar/i })).toBeVisible();
  });

  test('EC-M1-02 un enlace ya usado lleva al inicio de sesión', async ({ page, mailbox }) => {
    const email = mailbox.newEmail();
    await fillSignUp(page, email);
    const link = await mailbox.confirmationLink(email);
    await page.goto(link);
    await expect(page).toHaveURL(/\/bienvenida/);
    await page.context().clearCookies();
    await page.goto(link);
    await expect(page).toHaveURL(/\/entrar/);
  });
});
