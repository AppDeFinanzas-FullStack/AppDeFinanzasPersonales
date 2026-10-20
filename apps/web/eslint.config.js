import { createConfig } from '@finanzas/config/eslint';
import { defineConfig } from 'eslint/config';
import i18next from 'eslint-plugin-i18next';
import reactHooks from 'eslint-plugin-react-hooks';

export default defineConfig(
  createConfig({ tsconfigRootDir: import.meta.dirname }),
  reactHooks.configs.flat.recommended,
  {
    // RNF-07: every visible text lives in locales/es-BO, never as a literal in JSX.
    // components/ui is generated shadcn/ui code: it has no copy of its own.
    files: ['src/**/*.tsx'],
    ignores: ['src/components/ui/**'],
    extends: [i18next.configs['flat/recommended']],
    rules: { 'i18next/no-literal-string': ['error', { mode: 'jsx-text-only' }] },
  },
);
