import { baseConfig } from '@finanzas/config/vitest';
import { mergeConfig } from 'vitest/config';

export default mergeConfig(baseConfig, {
  test: {
    passWithNoTests: true,
    projects: [
      {
        extends: true,
        test: { name: 'unit', include: ['test/unit/**/*.test.ts'] },
      },
      {
        extends: true,
        test: {
          name: 'integration',
          include: ['test/integration/**/*.test.ts'],
          fileParallelism: false,
        },
      },
      {
        extends: true,
        test: { name: 'http', include: ['test/http/**/*.test.ts'] },
      },
    ],
  },
});
