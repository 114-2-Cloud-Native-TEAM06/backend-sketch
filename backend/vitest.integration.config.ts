import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    coverage: {
      // all: true,
      include: ['src/**/*.ts', 'services/**/*.ts', 'packages/**/*.ts'],
      exclude: [
        'packages/shared-types/**',
        '**/*.test.ts',
        '**/*.spec.ts',
        '**/__tests__/**',
        '**/main.ts',
        'tests/**',
        'scripts/**',
        '**/index.ts',
        '**/*.types.ts',
        '**/types.ts',
        'services/realtime-service/src/modules/realtime/presence.store.ts',
      ],
      provider: 'v8',
      reporter: ['text', 'json', 'json-summary', 'lcov'],
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
    include: ['tests/integration/**/*.integration.test.ts'],
    maxConcurrency: 1,
    setupFiles: ['./tests/helpers/integration-env.cjs'],
  },
});
