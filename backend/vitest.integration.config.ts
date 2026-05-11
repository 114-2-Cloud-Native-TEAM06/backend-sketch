import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    fileParallelism: false,
    include: ['tests/integration/**/*.test.ts'],
    maxConcurrency: 1,
    setupFiles: ['./tests/helpers/integration-env.js'],
  },
});
