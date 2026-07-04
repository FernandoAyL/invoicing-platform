import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
    // config.ts eagerly validates env on import (fail-fast); give tests a dummy value.
    // NODE_ENV=test keeps the pino-pretty dev transport off; LOG_LEVEL silences logs.
    env: { DATABASE_URL: 'postgres://test', NODE_ENV: 'test', LOG_LEVEL: 'silent' },
  },
});
