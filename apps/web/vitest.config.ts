import { fileURLToPath } from 'node:url';
import { baseConfig } from '@finanzas/config/vitest';
import { mergeConfig } from 'vitest/config';

export default mergeConfig(baseConfig, {
  resolve: {
    alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) },
  },
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts', 'src/**/*.test.ts'],
  },
});
