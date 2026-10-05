/// <reference types='vitest' />
import { nxViteTsPaths } from '@nx/vite/plugins/nx-tsconfig-paths.plugin';
import { defineConfig } from 'vitest/config';

// Hono is runtime-agnostic and needs no bindings here, so plain Node is enough and fast.
// Anything that touches D1 or the assets router lives in libs/worker/db or the apps, under workerd.
export default defineConfig(() => ({
  root: import.meta.dirname,
  cacheDir: '../../../node_modules/.vite/libs/worker/core',
  plugins: [nxViteTsPaths()],
  test: {
    name: 'worker-core',
    watch: false,
    globals: true,
    environment: 'node',
    include: ['src/**/*.spec.ts'],
    reporters: ['default'],
  },
}));
