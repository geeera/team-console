/// <reference types='vitest' />
import { defineConfig } from 'vite';

export default defineConfig(() => ({
  root: import.meta.dirname,
  cacheDir: '../../node_modules/.vite/tools/eslint-rules',
  test: {
    name: 'eslint-rules',
    watch: false,
    globals: true,
    environment: 'node',
    include: ['**/*.spec.ts'],
    reporters: ['default'],
    // The wiring spec runs real ESLint with a console project's config; a cold start takes a few seconds.
    testTimeout: 60_000,
  },
}));
