import { defineConfig } from 'vitest/config';
import path from 'path';
import os from 'os';

const TEST_DATA_DIR = path.resolve(__dirname, 'test-data');

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    root: path.resolve(__dirname),
    include: ['tests/**/*.test.ts'],
    exclude: ['tests/ai-integration/**', 'tests/setup-integration/**'],
    globalSetup: ['tests/globalSetup.ts'],
    setupFiles: ['tests/workerSetup.ts'],
    // Safety net: set test-only env vars so no test can accidentally hit
    // the real ~/.auramaxx/ or production DB. workerSetup.ts refines these
    // to per-worker subdirectories, but this catches the case where
    // setupFiles fail to run (e.g. single-file vitest invocations).
    env: {
      WALLET_DATA_DIR: TEST_DATA_DIR,
      DATABASE_URL: `file:${path.join(TEST_DATA_DIR, 'test.db')}`,
      NODE_ENV: 'test',
      WS_BROADCAST_URL: '',
      WS_URL: '',
      BYPASS_RATE_LIMIT: 'true',
      STRATEGY_CRON_SHARED_SECRET: 'test-cron-secret',
    },
    // forks = separate OS processes, each with own process.env and module instances
    pool: 'forks',
    maxWorkers: Math.max(1, os.cpus().length - 1),
    fileParallelism: true,
    testTimeout: 30000,
    hookTimeout: 30000,
    // Coverage configuration
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'html'],
      include: ['routes/**', 'lib/**'],
      exclude: ['tests/**', 'node_modules/**'],
    },
  },
});
