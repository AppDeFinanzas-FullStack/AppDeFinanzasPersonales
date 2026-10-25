import { existsSync, readFileSync } from 'node:fs';
import { parseEnv } from 'node:util';
import { defineConfig } from 'vitest/config';

// Locally, TEST_DATABASE_URL and TEST_TIMEOUT_MS come from the root .env (CI sets what it needs in
// the workflow). Only those keys are taken, and never over a value already in the environment.
const rootEnv = new URL('../../.env', import.meta.url);
const fileEnv = existsSync(rootEnv) ? parseEnv(readFileSync(rootEnv, 'utf8')) : {};
for (const key of ['TEST_DATABASE_URL', 'TEST_TIMEOUT_MS']) {
  const value = fileEnv[key];
  if (!process.env[key] && value) process.env[key] = value;
}

// A slow machine can raise the per-test limit (hooks get twice as much). Unset, Vitest's defaults
// (5 s and 10 s) apply, so CI keeps catching hung tests at the usual limit.
const testTimeout = Number(process.env['TEST_TIMEOUT_MS']);
const timeouts =
  Number.isInteger(testTimeout) && testTimeout > 0
    ? { testTimeout, hookTimeout: testTimeout * 2 }
    : {};

/** Shared Vitest settings. Each package extends them with `mergeConfig`. */
export const baseConfig = defineConfig({
  test: {
    passWithNoTests: true,
    reporters: ['default'],
    // `pnpm -r` runs the packages in parallel and they all share the root
    // node_modules/.vitest-cache; on Windows one run removes it while another uses it (EPERM).
    fsModuleCache: false,
    ...timeouts,
  },
});

export default baseConfig;
