import { existsSync, readFileSync } from 'node:fs';
import { parseEnv } from 'node:util';
import { defineConfig } from 'vitest/config';

// Locally, TEST_DATABASE_URL comes from the root .env (CI sets it in the workflow). Only that key
// is taken, and never over a value already in the environment.
const rootEnv = new URL('../../.env', import.meta.url);
if (!process.env['TEST_DATABASE_URL'] && existsSync(rootEnv)) {
  const url = parseEnv(readFileSync(rootEnv, 'utf8'))['TEST_DATABASE_URL'];
  if (url) process.env['TEST_DATABASE_URL'] = url;
}

/** Shared Vitest settings. Each package extends them with `mergeConfig`. */
export const baseConfig = defineConfig({
  test: {
    passWithNoTests: true,
    reporters: ['default'],
    // `pnpm -r` runs the packages in parallel and they all share the root
    // node_modules/.vitest-cache; on Windows one run removes it while another uses it (EPERM).
    fsModuleCache: false,
  },
});

export default baseConfig;
