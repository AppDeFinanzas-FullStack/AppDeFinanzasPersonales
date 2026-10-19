/**
 * Conventional Commits (constitution §7), limited to the commit types the project uses.
 * Task commits start their subject with the task id (`feat(db): TASK-003 ...`), so the subject case is free.
 */
module.exports = {
  extends: ['@commitlint/config-conventional'],
  rules: {
    'type-enum': [
      2,
      'always',
      ['feat', 'fix', 'docs', 'test', 'chore', 'build', 'ci', 'refactor', 'perf'],
    ],
    'subject-case': [0],
  },
};
