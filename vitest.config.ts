import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['sync-core/**/*.test.ts', 'extension/**/*.test.ts'],
    environment: 'node',
    setupFiles: ['tests/setup.ts'],
  },
});
