import { expect, test } from './fixtures/auth.js';
import type { TestUser } from './fixtures/auth.js';

import type { Locator, Page } from '@playwright/test';

const API_URL = `http://localhost:${process.env['API_PORT'] ?? '3000'}`;

const DRAFT_NAME = 'Borrador sin guardar';
const RECONNECT_TIMEOUT = 15_000;

interface Me {
  id: string;
  name: string;
  email: string;
}

async function readMe(page: Page): Promise<Me> {
  const res = await page.request.get('/api/me');
  expect(res.status()).toBe(200);
  return (await res.json()) as Me;
}

function nameField(page: Page): Locator {
  return page.getByLabel(/^nombre/i).first();
}

function saveProfileButton(page: Page): Locator {
  return page.getByRole('button', { name: /^guardar( cambios)?$/i });
}

function offlineNotice(page: Page): Locator {
  return page.getByText(/sin conexión/i).first();
}

function sessionDialog(page: Page): Locator {
  return page
    .getByRole('dialog')
    .or(page.getByRole('alertdialog'))
    .filter({ hasText: /sesión venció|vuelve a entrar/i });
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

/** Opens the profile, writes an unsaved name and waits until it is kept as a draft. */
async function writeProfileDraft(page: Page): Promise<Me> {
  await page.goto('/perfil');
  await expect(page).toHaveURL(/\/perfil/);
  const me = await readMe(page);
  await expect(nameField(page)).toHaveValue(me.name);
  await nameField(page).fill(DRAFT_NAME);
  await expect.poll(async () => (await draftKeysOf(page, me.id)).length).toBeGreaterThan(0);
  return me;
}

/** Drops the session cookie of this browser and makes a request that finds it gone. */
async function expireSession(page: Page): Promise<void> {
  await page.context().clearCookies();
  await saveProfileButton(page).click();
}

async function signInInDialog(dialog: Locator, user: TestUser): Promise<void> {
  await dialog.getByLabel(/correo/i).fill(user.email);
  await dialog.getByLabel(/contraseña/i).fill(user.password);
  await dialog.getByRole('button', { name: /entrar|iniciar sesión/i }).click();
}

/** Whether the element on top at the center of `target` belongs to the navigation. */
async function navigationReceivesPointer(page: Page, target: Locator): Promise<boolean> {
  const box = await target.boundingBox();
  if (box === null) throw new Error('the target has no box');
  const x = box.x + box.width / 2;
  const y = box.y + box.height / 2;
  return page.evaluate(
    ([px, py]) => document.elementFromPoint(px, py)?.closest('nav') != null,
    [x, y] as const,
  );
}

test.describe('TASK-075 bloqueo sin conexión', () => {
  test('RF-M2-07 RNF-23 sin conexión aparece el bloqueo y al reconectar desaparece solo', async ({
    authedPage,
    context,
  }) => {
    await authedPage.goto('/perfil');
    await expect(nameField(authedPage)).toBeVisible();
    await expect(offlineNotice(authedPage)).toBeHidden();

    await context.setOffline(true);
    await expect(offlineNotice(authedPage)).toBeVisible();

    await context.setOffline(false);
    await expect(offlineNotice(authedPage)).toBeHidden({ timeout: RECONNECT_TIMEOUT });
    await expect(authedPage).toHaveURL(/\/perfil/);
  });

  test('RF-M2-07 RNF-23 el bloqueo tapa toda la app, incluido Registrar', async ({
    authedPage,
    context,
  }) => {
    await authedPage.goto('/perfil');
    const register = authedPage
      .getByRole('navigation')
      .getByRole('link', { name: 'Registrar', exact: true })
      .first();
    await expect(register).toBeVisible();
    expect(await navigationReceivesPointer(authedPage, register)).toBe(true);

    await context.setOffline(true);
    await expect(offlineNotice(authedPage)).toBeVisible();

    const covered = authedPage.locator('nav a:visible', { hasText: 'Registrar' }).first();
    expect(await navigationReceivesPointer(authedPage, covered)).toBe(false);

    await context.setOffline(false);
    await expect(offlineNotice(authedPage)).toBeHidden({ timeout: RECONNECT_TIMEOUT });
    expect(await navigationReceivesPointer(authedPage, register)).toBe(true);
  });

  test('RF-M2-07 al reconectar se actualizan los datos', async ({ authedPage, context }) => {
    await authedPage.goto('/perfil');
    await expect(nameField(authedPage)).toBeVisible();

    await context.setOffline(true);
    await expect(offlineNotice(authedPage)).toBeVisible();

    const refetch = authedPage.waitForRequest(
      (req) => req.method() === 'GET' && new URL(req.url()).pathname.startsWith('/api/me'),
      { timeout: RECONNECT_TIMEOUT },
    );
    await context.setOffline(false);
    await refetch;
    await expect(offlineNotice(authedPage)).toBeHidden({ timeout: RECONNECT_TIMEOUT });
  });

  test('RF-M2-10 el borrador del perfil sigue ahí al reconectar', async ({
    authedPage,
    context,
  }) => {
    await writeProfileDraft(authedPage);

    await context.setOffline(true);
    await expect(offlineNotice(authedPage)).toBeVisible();
    await expect(nameField(authedPage)).toHaveValue(DRAFT_NAME);

    await context.setOffline(false);
    await expect(offlineNotice(authedPage)).toBeHidden({ timeout: RECONNECT_TIMEOUT });
    await expect(authedPage).toHaveURL(/\/perfil/);
    await expect(nameField(authedPage)).toHaveValue(DRAFT_NAME);
  });
});

test.describe('TASK-075 diálogo de sesión vencida', () => {
  test('RF-M2-08 con la sesión vencida se pide iniciar sesión encima de la misma pantalla', async ({
    authedPage,
  }) => {
    await writeProfileDraft(authedPage);
    await expireSession(authedPage);

    const dialog = sessionDialog(authedPage);
    await expect(dialog).toBeVisible();
    await expect(dialog.getByLabel(/correo/i)).toBeVisible();
    await expect(dialog.getByLabel(/contraseña/i)).toBeVisible();
    await expect(authedPage).toHaveURL(/\/perfil/);
    await expect(nameField(authedPage)).toHaveValue(DRAFT_NAME);
  });

  test('RF-M2-08 RF-M2-10 iniciar sesión con el mismo usuario vuelve a la misma pantalla con el borrador', async ({
    authedPage,
    testUser,
  }) => {
    const me = await writeProfileDraft(authedPage);
    await expireSession(authedPage);

    const dialog = sessionDialog(authedPage);
    await expect(dialog).toBeVisible();
    await signInInDialog(dialog, testUser);

    await expect(dialog).toBeHidden();
    await expect(authedPage).toHaveURL(/\/perfil/);
    await expect(nameField(authedPage)).toHaveValue(DRAFT_NAME);
    expect((await readMe(authedPage)).id).toBe(me.id);
    expect((await draftKeysOf(authedPage, me.id)).length).toBeGreaterThan(0);
  });

  test('EC-M2-01 RF-M2-10 si entra otro usuario el borrador anterior se descarta', async ({
    authedPage,
    request,
  }) => {
    const first = await writeProfileDraft(authedPage);

    const res = await request.post(`${API_URL}/internal/test/users`, { data: {} });
    expect(res.status()).toBe(201);
    const other = (await res.json()) as TestUser;

    await expireSession(authedPage);
    const dialog = sessionDialog(authedPage);
    await expect(dialog).toBeVisible();
    await signInInDialog(dialog, other);

    await expect(dialog).toBeHidden();
    await expect(authedPage).toHaveURL((url) => url.pathname === '/');
    const second = await readMe(authedPage);
    expect(second.email).toBe(other.email);
    expect(second.id).not.toBe(first.id);
    await expect.poll(async () => draftKeysOf(authedPage, first.id)).toEqual([]);

    await authedPage.goto('/perfil');
    await expect(nameField(authedPage)).toHaveValue(second.name);
    await expect(nameField(authedPage)).not.toHaveValue(DRAFT_NAME);
  });
});
