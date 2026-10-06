/// <reference types='vitest' />
import { defineConfig } from 'vitest/config';

export default defineConfig(() => ({
  root: import.meta.dirname,
  cacheDir: '../../node_modules/.vite/apps/console-e2e',
  test: {
    name: 'console-e2e',
    watch: false,
    environment: 'node',
    // Playwright specs (*.e2e.ts) run only through `nx e2e console-e2e`; this config is for the plain unit specs
    // next to the e2e support helpers (e.g. tap-target.spec.ts).
    include: ['src/**/*.spec.ts'],
    reporters: ['default'],
  },
}));
