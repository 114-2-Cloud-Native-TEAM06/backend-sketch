import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    coverage: {
      all: true,
      include: ['services/**/*.ts', 'packages/**/*.ts'],
      exclude: ['**/*.unit.test.ts', 'packages/shared-types/**'],
      provider: 'v8',
      reporter: ['text', 'json-summary', 'lcov'],
      reportsDirectory: 'coverage/unit',
      thresholds: {
        branches: 45,
        functions: 55,
        lines: 55,
        statements: 55,
      },
    },
    environment: 'node',
    include: ['services/**/*.unit.test.ts', 'packages/**/*.unit.test.ts'],
    setupFiles: ['./tests/helpers/integration-env.cjs'],
  },
});
