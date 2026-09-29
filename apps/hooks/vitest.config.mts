/// <reference types='vitest' />
import { resolve } from 'node:path';
import { cloudflareTest, readD1Migrations } from '@cloudflare/vitest-pool-workers';
import { nxViteTsPaths } from '@nx/vite/plugins/nx-tsconfig-paths.plugin';
import { defineConfig } from 'vitest/config';

// Same shape as apps/api: workerd, the real wrangler.jsonc (env `dev`), an isolated D1 migrated from the api
// Worker's folder — the one place the shared schema lives.
export default defineConfig(async () => ({
  root: import.meta.dirname,
  cacheDir: '../../node_modules/.vite/apps/hooks',
  plugins: [
    nxViteTsPaths(),
    cloudflareTest({
      wrangler: { configPath: './wrangler.jsonc', environment: 'dev' },
      miniflare: {
        bindings: {
          TEST_MIGRATIONS: await readD1Migrations(resolve(import.meta.dirname, '../api/migrations')),
        },
      },
    }),
  ],
  test: {
    name: 'hooks',
    watch: false,
    globals: true,
    include: ['src/**/*.spec.ts'],
    setupFiles: ['src/test-setup.ts'],
    reporters: ['default'],
  },
}));
