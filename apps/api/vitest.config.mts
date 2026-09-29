/// <reference types='vitest' />
import { resolve } from 'node:path';
import { cloudflareTest, readD1Migrations } from '@cloudflare/vitest-pool-workers';
import { nxViteTsPaths } from '@nx/vite/plugins/nx-tsconfig-paths.plugin';
import { defineConfig } from 'vitest/config';

// Integration tests through `SELF.fetch` inside workerd, with the real wrangler.jsonc (env `dev`), an isolated
// in-memory D1 migrated in src/test-setup.ts, and the assets router from the config.
export default defineConfig(async () => ({
  root: import.meta.dirname,
  cacheDir: '../../node_modules/.vite/apps/api',
  plugins: [
    nxViteTsPaths(),
    cloudflareTest({
      wrangler: { configPath: './wrangler.jsonc', environment: 'dev' },
      miniflare: {
        // The Angular build is not a prerequisite of the Worker's tests: a one-page fixture stands in for
        // dist/apps/console/browser. Binding, SPA fallback and run_worker_first still come from wrangler.jsonc.
        assets: { directory: resolve(import.meta.dirname, 'test-assets') },
        bindings: {
          TEST_MIGRATIONS: await readD1Migrations(resolve(import.meta.dirname, 'migrations')),
          // The auth placeholder fails closed; route specs run with the local bypass the way `nx serve api`
          // and the Dockerfile do. auth.middleware.spec.ts overrides these per case.
          ENVIRONMENT: 'local',
          AUTH_MODE: 'local',
        },
      },
    }),
  ],
  test: {
    name: 'api',
    watch: false,
    globals: true,
    include: ['src/**/*.spec.ts'],
    setupFiles: ['src/test-setup.ts'],
    reporters: ['default'],
  },
}));
