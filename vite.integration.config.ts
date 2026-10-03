import { defineConfig, mergeConfig } from 'vite-plus';
import base from './vite.config';
const { test: _unitTests, ...shared } = base;
export default mergeConfig(
  shared,
  defineConfig({
    test: {
      include: ['tests/*.integration.test.ts'],
      environment: 'node',
      setupFiles: ['tests/setup.ts'],
      testTimeout: 30_000,
      hookTimeout: 30_000,
    },
  }),
);
