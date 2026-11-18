/// <reference types='vitest' />
import { nxViteTsPaths } from '@nx/vite/plugins/nx-tsconfig-paths.plugin';
import { defineConfig } from 'vitest/config';

// Plain Node: the runner is a CLI on the customer's host, not a Worker — apps/hooks' shape minus the Workers pool.

/**
 * Specs that spawn a real `git` (the mirror/clone/vendor flow, or a fixture repo): several short-lived processes
 * each, so running many of these files at once is what pushed the host's load average past its core count and
 * made `git archive` itself time out, not just the vitest test around it (#846). Split into their own serial
 * project below instead of raising the suite's global `testTimeout`.
 */
const GIT_SPAWNING_SPECS = [
  'src/cli/run-once-oidc.spec.ts',
  'src/integration/oidc-run.integration.spec.ts',
  'src/jobs/lifecycle.spec.ts',
  'src/git/plugin.spec.ts',
  'src/git/workspace.spec.ts',
  'src/git/git-config.spec.ts',
];

export default defineConfig(() => ({
  root: import.meta.dirname,
  cacheDir: '../../node_modules/.vite/apps/runner',
  plugins: [nxViteTsPaths()],
  test: {
    name: 'runner',
    watch: false,
    globals: true,
    environment: 'node',
    reporters: ['default'],
    // Real git/process-group work (mirror sync, clone, vendor, the `none` backend's SIGTERM grace), not a
    // hang: the 5 s default is tight for that under CPU contention — e.g. two suites running at once — and
    // was timing out specs that were otherwise correct (#702). 20 s gives real I/O room without masking an
    // actual hang; a few specs that legitimately run longer still set their own explicit timeout.
    testTimeout: 20_000,
    // Specs never reach the developer's real Keychain; the keychain path is driven by a fake `security` (#585).
    env: { TC_RUNNER_KEY_STORE: 'file' },
    projects: [
      {
        extends: true,
        test: {
          name: 'runner',
          include: ['src/**/*.spec.ts'],
          exclude: GIT_SPAWNING_SPECS,
        },
      },
      {
        extends: true,
        test: {
          name: 'runner:git',
          include: GIT_SPAWNING_SPECS,
          // One file at a time: these specs' own real git processes are the load this suite must not add to
          // itself, on top of whatever else is running on the host (#846).
          fileParallelism: false,
        },
      },
    ],
  },
}));
