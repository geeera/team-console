/// <reference types='vitest' />
import { nxViteTsPaths } from '@nx/vite/plugins/nx-tsconfig-paths.plugin';
import { defineConfig } from 'vitest/config';

// Plain Node: the runner is a CLI on the customer's host, not a Worker — apps/hooks' shape minus the Workers pool.
export default defineConfig(() => ({
  root: import.meta.dirname,
  cacheDir: '../../node_modules/.vite/apps/runner',
  plugins: [nxViteTsPaths()],
  test: {
    name: 'runner',
    watch: false,
    globals: true,
    environment: 'node',
    include: ['src/**/*.spec.ts'],
    reporters: ['default'],
    // Real git/process-group work (mirror sync, clone, vendor, the `none` backend's SIGTERM grace), not a
    // hang: the 5 s default is tight for that under CPU contention — e.g. two suites running at once — and
    // was timing out specs that were otherwise correct (#702). 20 s gives real I/O room without masking an
    // actual hang; a few specs that legitimately run longer still set their own explicit timeout.
    testTimeout: 20_000,
    // Specs never reach the developer's real Keychain; the keychain path is driven by a fake `security` (#585).
    env: { TC_RUNNER_KEY_STORE: 'file' },
  },
}));
