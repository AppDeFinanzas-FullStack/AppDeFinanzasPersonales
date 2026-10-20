import { expect, test as base } from './mailbox.js';
import type { MailboxFixtures } from './mailbox.js';
import type { BaseFixtures } from './base.js';

import type { Page } from '@playwright/test';

const API_URL = `http://localhost:${process.env['API_PORT'] ?? '3000'}`;

export interface TestUser {
  email: string;
  password: string;
}

export interface AuthFixtures {
  /** A confirmed user with the Onboarding finished, created with `POST /internal/test/users`. */
  testUser: TestUser;
  /** A page already signed in as `testUser`. */
  authedPage: Page;
}

/** Extends the mailbox `test` with a ready user and a signed-in page (plan §1.5). */
export const test = base.extend<AuthFixtures & MailboxFixtures & BaseFixtures>({
  testUser: async ({ request }, use) => {
    const res = await request.post(`${API_URL}/internal/test/users`, { data: {} });
    expect(res.status()).toBe(201);
    await use((await res.json()) as TestUser);
  },
  authedPage: async ({ page, testUser }, use) => {
    await page.goto('/entrar');
    await page.getByLabel(/correo/i).fill(testUser.email);
    await page.getByLabel(/contraseña/i).fill(testUser.password);
    await page.getByRole('button', { name: /entrar|iniciar sesión/i }).click();
    await expect(page).not.toHaveURL(/\/entrar/);
    await use(page);
  },
});

export { expect };
