import { expect, test } from './fixtures/auth.js';

import type { Page } from '@playwright/test';

async function fillForm(page: Page, password: string, word: string): Promise<void> {
  await page.getByLabel(/contraseña/i).first().fill(password);
  await page.getByLabel(/eliminar/i).last().fill(word);
}

async function submit(page: Page): Promise<void> {
  await page.getByRole('button', { name: /eliminar (mi )?cuenta|eliminar definitivamente|eliminar/i }).last().click();
}

test.describe('TASK-076 eliminar la cuenta', () => {
  test('RF-M1-15 Eliminar la cuenta: con la contraseña y ELIMINAR se cierra la sesión y llega el correo', async ({
    authedPage,
    testUser,
    mailbox,
  }) => {
    await authedPage.goto('/perfil/eliminar');
    await expect(authedPage).toHaveURL(/\/perfil\/eliminar/);
    await fillForm(authedPage, testUser.password, 'ELIMINAR');
    await submit(authedPage);

    await expect(authedPage).toHaveURL(/\/entrar/);
    await authedPage.goto('/perfil');
    await expect(authedPage).toHaveURL(/\/entrar/);

    await expect
      .poll(
        async () =>
          (await mailbox.inboxOf(testUser.email)).filter((e) => e.kind === 'account_deleted')
            .length,
        { timeout: 15_000 },
      )
      .toBeGreaterThanOrEqual(1);
  });

  test('RF-M1-15 tras eliminar, la contraseña ya no permite entrar', async ({
    authedPage,
    testUser,
  }) => {
    await authedPage.goto('/perfil/eliminar');
    await fillForm(authedPage, testUser.password, 'ELIMINAR');
    await submit(authedPage);
    await expect(authedPage).toHaveURL(/\/entrar/);

    await authedPage.getByLabel(/correo/i).fill(testUser.email);
    await authedPage.getByLabel(/contraseña/i).fill(testUser.password);
    await authedPage.getByRole('button', { name: /entrar|iniciar sesión/i }).click();
    await expect(authedPage).toHaveURL(/\/entrar/);
    await expect(authedPage.getByRole('alert').first()).toBeVisible();
  });

  test('EC-M1-08 con una palabra distinta se muestra el motivo y no se elimina nada', async ({
    authedPage,
    testUser,
    mailbox,
  }) => {
    await authedPage.goto('/perfil/eliminar');
    await fillForm(authedPage, testUser.password, 'eliminar ya');
    await submit(authedPage);

    await expect(authedPage.getByText(/ELIMINAR/).first()).toBeVisible();
    await expect(authedPage).toHaveURL(/\/perfil\/eliminar/);

    await authedPage.goto('/perfil');
    await expect(authedPage).toHaveURL(/\/perfil/);
    expect((await mailbox.inboxOf(testUser.email)).filter((e) => e.kind === 'account_deleted'))
      .toHaveLength(0);
  });

  test('EC-M1-08 con la contraseña incorrecta se explica el motivo y no se elimina nada', async ({
    authedPage,
    testUser,
    mailbox,
  }) => {
    await authedPage.goto('/perfil/eliminar');
    await fillForm(authedPage, 'Contrasena-incorrecta-9', 'ELIMINAR');
    await submit(authedPage);

    await expect(authedPage.getByText(/contraseña.*(incorrecta|no coincide|no es correcta)/i).first()).toBeVisible();
    await expect(authedPage).toHaveURL(/\/perfil\/eliminar/);

    await authedPage.goto('/perfil');
    await expect(authedPage).toHaveURL(/\/perfil/);
    expect((await mailbox.inboxOf(testUser.email)).filter((e) => e.kind === 'account_deleted'))
      .toHaveLength(0);
  });
});
