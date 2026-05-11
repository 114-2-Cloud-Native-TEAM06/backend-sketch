import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    coverage: {
      all: true,
      include: ['src/middleware/**/*.ts', 'src/routes/**/*.ts'],
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
    include: ['tests/unit/**/*.test.ts'],
  },
});
