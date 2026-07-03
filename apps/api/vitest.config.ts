import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
    // config.ts eagerly validates env on import (fail-fast); give tests a dummy value.
    env: { DATABASE_URL: 'postgres://test' },
  },
});
