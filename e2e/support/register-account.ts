import { expect, type Locator, type Page } from '@playwright/test';

/**
 * The account selector of Registrar (the card of the account on its first level). It is looked up
 * by role: "Cuenta" is also the name of other groups of the page.
 */
export function accountSelect(page: Page): Locator {
  return page.getByRole('combobox', { name: 'Cuenta', exact: true });
}

/** The accounts the selector offers, one option each. */
export function accountOptions(page: Page): Locator {
  return accountSelect(page).locator('option');
}

const escapeRegExp = (text: string): string => text.replace(/[\\^$.*+?()[\]{}|]/g, '\\$&');

/** The account the selector has chosen right now, by its name; each option reads "Name (CODE)". */
export async function expectAccountChosen(page: Page, name: string): Promise<void> {
  await expect(accountSelect(page)).toBeVisible();
  await expect(accountSelect(page).locator('option:checked')).toHaveText(
    new RegExp(`^${escapeRegExp(name)} \\(`),
  );
}
