import { expect, test } from './fixtures/base.js';

const PROJECTS = [
  'chromium-360',
  'chromium-1280',
  'webkit-360',
  'webkit-1280',
  'firefox-360',
  'firefox-1280',
];

test.describe('TASK-046 smoke', () => {
  test('TASK-046 /api/health responde 204 a través del proxy de la web', async ({ request }) => {
    const res = await request.get('/api/health');
    expect(res.status()).toBe(204);
  });

  test('TASK-046 la web carga desde vite preview', async ({ page }) => {
    const res = await page.goto('/');
    expect(res?.status()).toBe(200);
    await expect(page.locator('html')).toHaveAttribute('lang', 'es-BO');
    await expect(page.locator('main')).toBeAttached();
  });

  test('RNF-06 TASK-046 la web carga sin violaciones serias o críticas de axe', async ({
    page,
    checkA11y,
  }) => {
    await page.goto('/');
    await expect(page.locator('main')).toBeAttached();
    await checkA11y();
  });

  test('RNF-05 TASK-046 el proyecto corre en la matriz de navegadores y anchos', async ({
    page,
    projectWidth,
  }, testInfo) => {
    expect(PROJECTS).toContain(testInfo.project.name);
    expect(page.viewportSize()?.width).toBe(projectWidth);
    const res = await page.goto('/');
    expect(res?.status()).toBe(200);
  });
});
