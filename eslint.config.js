import { createConfig } from '@finanzas/config/eslint';
import { defineConfig, globalIgnores } from 'eslint/config';

export default defineConfig(
  // SDD pipeline scripts: built outside tasks.md and verified with `node --test` (execution protocol).
  // .claude/worktrees: checkouts of other sessions, each linted in its own folder.
  globalIgnores(['tools/', '.claude/worktrees/']),
  createConfig({ tsconfigRootDir: import.meta.dirname }),
);
