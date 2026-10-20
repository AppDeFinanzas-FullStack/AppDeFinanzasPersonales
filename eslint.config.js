import { createConfig } from '@finanzas/config/eslint';
import { defineConfig, globalIgnores } from 'eslint/config';

export default defineConfig(
  // SDD pipeline scripts: built outside tasks.md and verified with `node --test` (execution protocol).
  globalIgnores(['tools/']),
  createConfig({ tsconfigRootDir: import.meta.dirname }),
);
