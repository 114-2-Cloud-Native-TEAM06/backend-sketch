import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    coverage: {
      all: true,
      exclude: ['src/types/**'],
      include: ['src/**/*.ts'],
      provider: 'v8',
      reporter: ['text', 'json-summary', 'lcov'],
      reportsDirectory: 'coverage/integration',
      thresholds: {
        branches: 50,
        functions: 50,
        lines: 60,
        statements: 60,
      },
    },
    environment: 'node',
    fileParallelism: false,
    include: ['tests/integration/**/*.test.ts'],
    maxConcurrency: 1,
    setupFiles: ['./tests/helpers/integration-env.cjs'],
  },
});
