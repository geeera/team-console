/// <reference types='vitest' />
import { cloudflareTest } from '@cloudflare/vitest-pool-workers';
import { nxViteTsPaths } from '@nx/vite/plugins/nx-tsconfig-paths.plugin';
import { defineConfig } from 'vitest/config';

// Inside workerd, so the WebCrypto the Worker uses (ECDH P-256, HKDF, AES-GCM, ECDSA) is the one under test.
export default defineConfig(() => ({
  root: import.meta.dirname,
  cacheDir: '../../../node_modules/.vite/libs/worker/push',
  plugins: [
    nxViteTsPaths(),
    cloudflareTest({
      miniflare: { compatibilityDate: '2026-08-15' },
    }),
  ],
  test: {
    name: 'worker-push',
    watch: false,
    globals: true,
    include: ['src/**/*.spec.ts'],
    reporters: ['default'],
  },
}));
