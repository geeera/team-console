/// <reference types='vitest' />
import { resolve } from 'node:path';
import { cloudflareTest, readD1Migrations } from '@cloudflare/vitest-pool-workers';
import { nxViteTsPaths } from '@nx/vite/plugins/nx-tsconfig-paths.plugin';
import { defineConfig } from 'vitest/config';

// Runs inside workerd with an in-memory D1. The migrations are the api Worker's — the one place they live —
// so the repository is tested against the schema that will be deployed.
export default defineConfig(async () => ({
  root: import.meta.dirname,
  cacheDir: '../../../node_modules/.vite/libs/worker/db',
  plugins: [
    nxViteTsPaths(),
    cloudflareTest({
      miniflare: {
        compatibilityDate: '2026-08-15',
        d1Databases: ['DB'],
        bindings: {
          TEST_MIGRATIONS: await readD1Migrations(
            resolve(import.meta.dirname, '../../../apps/api/migrations'),
          ),
        },
      },
    }),
  ],
  test: {
    name: 'worker-db',
    watch: false,
    globals: true,
    include: ['src/**/*.spec.ts'],
    setupFiles: ['src/test-setup.ts'],
    reporters: ['default'],
  },
}));
