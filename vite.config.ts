import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite-plus';

export default defineConfig({
  resolve: { alias: { '@': fileURLToPath(new URL('./extension', import.meta.url)) } },
  test: {
    include: ['sync-core/**/*.test.ts', 'extension/**/*.test.ts'],
    environment: 'node',
    setupFiles: ['tests/setup.ts'],
    maxWorkers: process.env.CI ? 2 : undefined,
  },
  lint: {
    ignorePatterns: ['work/**', 'target/**', '**/.wxt/**', '**/.output/**', 'release/**'],
    jsPlugins: [{ name: 'vite-plus', specifier: 'vite-plus/oxlint-plugin' }],
    rules: { 'vite-plus/prefer-vite-plus-imports': 'error' },
    options: { typeAware: true, typeCheck: true },
  },
  fmt: {
    singleQuote: true,
    printWidth: 100,
    sortPackageJson: false,
    ignorePatterns: [
      'node_modules/',
      '**/.wxt/',
      '**/.output/',
      'target/',
      'work/',
      'data/',
      'release/',
      'pnpm-lock.yaml',
      'Cargo.lock',
      '*.rs',
      '*.sql',
      '*.toml',
      'web-ext.config.ts',
    ],
  },
});
