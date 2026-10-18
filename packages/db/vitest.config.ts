import { baseConfig } from '@finanzas/config/vitest';
import { mergeConfig } from 'vitest/config';

export default mergeConfig(baseConfig, {
  test: {
    include: ['test/**/*.test.ts'],
    globalSetup: ['./test/global-setup.ts'],
    fileParallelism: false,
  },
});
