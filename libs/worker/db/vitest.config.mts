/// <reference types='vitest' />
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { cloudflareTest, readD1Migrations } from '@cloudflare/vitest-pool-workers';
import { nxViteTsPaths } from '@nx/vite/plugins/nx-tsconfig-paths.plugin';
import { defineConfig } from 'vitest/config';

const PLUGIN = resolve(import.meta.dirname, '../../../.claude/product-team');

// The vendored plugin file the label seed is generated from, read here because workerd has no file system:
// labels-seed.spec.ts compares it with the digest the seed records.
function vendoredLabels(): { version: string; sha256: string } {
  const manifest = JSON.parse(readFileSync(resolve(PLUGIN, '.claude-plugin/plugin.json'), 'utf8')) as {
    version: string;
  };
  const sha256 = createHash('sha256')
    .update(readFileSync(resolve(PLUGIN, 'scripts/ptlib/labels.py')))
    .digest('hex');
  return { version: manifest.version, sha256 };
}

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
          TEST_PLUGIN_VERSION: vendoredLabels().version,
          TEST_PLUGIN_LABELS_SHA256: vendoredLabels().sha256,
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
