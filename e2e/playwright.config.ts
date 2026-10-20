import { defineConfig, devices } from '@playwright/test';

const API_PORT = 3000;
const WEB_PORT = 4173;
const WEB_URL = `http://localhost:${WEB_PORT}`;

/** Ephemeral test database (plan §1.5): CI sets TEST_DATABASE_URL, locally it is the docker-compose one. */
const DATABASE_URL =
  process.env['TEST_DATABASE_URL'] ?? 'postgresql://postgres:postgres@localhost:5432/finanzas_test';

/** Release the API runs with; `e2e:release-1.0` sets it to 1.0 (plan §5.1). */
const RELEASE = process.env['E2E_RELEASE'] ?? '1.2';

const isCI = process.env['CI'] !== undefined;

const WIDTHS = [360, 1280] as const;
const VIEWPORT_HEIGHT = 800;

const BROWSERS = [
  { name: 'chromium', device: devices['Desktop Chrome'] },
  { name: 'webkit', device: devices['Desktop Safari'] },
  { name: 'firefox', device: devices['Desktop Firefox'] },
] as const;

/** Chromium, WebKit and Firefox at 360 px and 1280 px (RNF-05). */
const projects = BROWSERS.flatMap(({ name, device }) =>
  WIDTHS.map((width) => ({
    name: `${name}-${width}`,
    use: { ...device, viewport: { width, height: VIEWPORT_HEIGHT } },
  })),
);

export default defineConfig({
  testDir: '.',
  testMatch: '**/*.spec.ts',
  fullyParallel: true,
  forbidOnly: isCI,
  retries: isCI ? 2 : 0,
  reporter: isCI ? [['html', { open: 'never' }], ['list']] : 'list',
  use: {
    baseURL: WEB_URL,
    trace: 'retain-on-failure',
    video: 'retain-on-failure',
  },
  projects,
  webServer: [
    {
      // API over the migrated test database, with fake integrations (plan §1.5).
      command:
        'pnpm --filter @finanzas/db exec prisma generate && pnpm --filter @finanzas/db exec prisma migrate deploy && pnpm --filter api start',
      url: `http://localhost:${API_PORT}/api/health`,
      reuseExistingServer: !isCI,
      timeout: 120_000,
      env: {
        NODE_ENV: 'test',
        PORT: String(API_PORT),
        DATABASE_URL,
        DATABASE_URL_DIRECT: DATABASE_URL,
        AUTH_SECRET: process.env['AUTH_SECRET'] ?? 'e2e-auth-secret-0123456789abcdef0123456789',
        HMAC_SECRET: process.env['HMAC_SECRET'] ?? 'e2e-hmac-secret-0123456789abcdef0123456789',
        JOBS_SECRET: process.env['JOBS_SECRET'] ?? 'e2e-jobs-secret-0123456789abcdef0123456789',
        RESEND_API_KEY: 'fake',
        RELEASE,
        WEB_ORIGIN: WEB_URL,
        INTEGRATIONS: 'fake',
      },
    },
    {
      // Compiled web served by `vite preview`, which proxies `/api` to the API.
      command: `pnpm --filter web exec vite build && pnpm --filter web exec vite preview --port ${WEB_PORT} --strictPort`,
      url: WEB_URL,
      reuseExistingServer: !isCI,
      timeout: 180_000,
    },
  ],
});
