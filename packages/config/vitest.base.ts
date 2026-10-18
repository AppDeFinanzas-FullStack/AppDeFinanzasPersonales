import { defineConfig } from 'vitest/config';

/** Shared Vitest settings. Each package extends them with `mergeConfig`. */
export const baseConfig = defineConfig({
  test: {
    passWithNoTests: true,
    reporters: ['default'],
  },
});

export default baseConfig;
