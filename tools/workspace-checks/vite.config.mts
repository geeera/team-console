/// <reference types='vitest' />
import { nxViteTsPaths } from '@nx/vite/plugins/nx-tsconfig-paths.plugin';
import { defineConfig } from 'vite';

export default defineConfig(() => ({
  root: import.meta.dirname,
  cacheDir: '../../node_modules/.vite/tools/workspace-checks',
  // The release-identity specs compare the guard scripts with @shared/contracts at run time.
  plugins: [nxViteTsPaths()],
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
