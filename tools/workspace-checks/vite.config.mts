/// <reference types='vitest' />
import { defineConfig } from 'vite';

export default defineConfig(() => ({
  root: import.meta.dirname,
  cacheDir: '../../node_modules/.vite/tools/workspace-checks',
  test: {
    name: 'workspace-checks',
    watch: false,
    globals: true,
    environment: 'node',
    include: ['src/**/*.spec.ts'],
    reporters: ['default'],
    // ESLint + the Nx project graph take a few seconds on a cold cache.
    testTimeout: 60_000,
    hookTimeout: 60_000,
  },
}));
