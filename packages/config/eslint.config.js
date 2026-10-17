import { resolve } from 'node:path';
import js from '@eslint/js';
import { defineConfig, globalIgnores } from 'eslint/config';
import tseslint from 'typescript-eslint';

const TEST_APIS = '/^(describe|it|test|suite|bench)$/';
const FOCUS_OR_SKIP = '/^(only|skip)$/';
const FOCUS_OR_SKIP_MESSAGE =
  'Focused or skipped tests are not allowed: every test must run in CI (constitution §5).';

const PARSE_FLOAT_MESSAGE =
  'Money and rates must use exact decimals (decimal.js), never floating point (constitution §3).';

/** Folders whose code handles money and rates: floating point parsing is forbidden there. */
const MONEY_PATHS = ['packages/domain/**', 'packages/contracts/**', 'apps/api/src/**'];

/**
 * Shared flat config: typescript-eslint with type information, plus the project rules.
 * `tsconfigRootDir` bounds the tsconfig.json lookup: it must contain the tsconfig of the linted files.
 *
 * @param {{ tsconfigRootDir: string }} options
 */
export function createConfig({ tsconfigRootDir }) {
  return defineConfig(
    globalIgnores(['**/dist/', '**/coverage/', '**/playwright-report/', '**/test-results/']),
    js.configs.recommended,
    tseslint.configs.recommendedTypeChecked,
    {
      languageOptions: {
        parserOptions: {
          projectService: true,
          tsconfigRootDir,
        },
      },
      rules: {
        'no-restricted-syntax': [
          'error',
          {
            selector: `MemberExpression[object.name=${TEST_APIS}][property.name=${FOCUS_OR_SKIP}]`,
            message: FOCUS_OR_SKIP_MESSAGE,
          },
          {
            selector: `MemberExpression[object.object.name=${TEST_APIS}][property.name=${FOCUS_OR_SKIP}]`,
            message: FOCUS_OR_SKIP_MESSAGE,
          },
        ],
      },
    },
    {
      files: MONEY_PATHS,
      rules: {
        'no-restricted-globals': ['error', { name: 'parseFloat', message: PARSE_FLOAT_MESSAGE }],
        'no-restricted-properties': [
          'error',
          { object: 'Number', property: 'parseFloat', message: PARSE_FLOAT_MESSAGE },
          { object: 'globalThis', property: 'parseFloat', message: PARSE_FLOAT_MESSAGE },
        ],
      },
    },
  );
}

// Used by ESLint for the files of this package; the type information comes from the root tsconfig.json.
export default createConfig({ tsconfigRootDir: resolve(import.meta.dirname, '..', '..') });
