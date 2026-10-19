import { defineConfig } from 'vitest/config';

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
