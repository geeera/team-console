/// <reference types='vitest' />
import { webcrypto } from 'node:crypto';
import { resolve } from 'node:path';
import { cloudflareTest, readD1Migrations } from '@cloudflare/vitest-pool-workers';
import { nxViteTsPaths } from '@nx/vite/plugins/nx-tsconfig-paths.plugin';
import { defineConfig } from 'vitest/config';

// A GitHub App key generated for this run only: no test may read a real GitHub credential (ADR 0003, #9).
async function generateTestAppKey(): Promise<{ pem: string; publicJwk: string }> {
  const { privateKey, publicKey } = await webcrypto.subtle.generateKey(
    {
      name: 'RSASSA-PKCS1-v1_5',
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: 'SHA-256',
    },
    true,
    ['sign', 'verify'],
  );
  const der = Buffer.from(await webcrypto.subtle.exportKey('pkcs8', privateKey)).toString('base64');
  const body = der.match(/.{1,64}/g)?.join('\n') ?? '';
  return {
    pem: `-----BEGIN PRIVATE KEY-----\n${body}\n-----END PRIVATE KEY-----\n`,
    publicJwk: JSON.stringify(await webcrypto.subtle.exportKey('jwk', publicKey)),
  };
}

// Integration tests through `SELF.fetch` inside workerd, with the real wrangler.jsonc (env `dev`), an isolated
// in-memory D1 migrated in src/test-setup.ts, and the assets router from the config.
export default defineConfig(async () => {
  const appKey = await generateTestAppKey();
  return {
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
            GITHUB_APP_ID: '123456',
            GITHUB_APP_PRIVATE_KEY: appKey.pem,
            TEST_GITHUB_APP_PUBLIC_JWK: appKey.publicJwk,
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
  };
});
