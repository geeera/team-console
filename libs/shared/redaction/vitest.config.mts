/// <reference types='vitest' />
import { nxViteTsPaths } from '@nx/vite/plugins/nx-tsconfig-paths.plugin';
import { defineConfig } from 'vitest/config';

export default defineConfig(() => ({
  root: import.meta.dirname,
  cacheDir: '../../../node_modules/.vite/libs/shared/redaction',
  // The free-text check (#477) strips invisible characters with @shared/plain-text at run time.
  plugins: [nxViteTsPaths()],
  test: {
    name: 'shared-redaction',
    watch: false,
    globals: true,
    environment: 'node',
    include: ['src/**/*.spec.ts'],
    reporters: ['default'],
  },
}));
