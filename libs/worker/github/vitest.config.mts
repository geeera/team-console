/// <reference types='vitest' />
import { nxViteTsPaths } from '@nx/vite/plugins/nx-tsconfig-paths.plugin';
import { defineConfig } from 'vitest/config';

// Pure logic over fetch and Web Crypto, both global in Node 22, so plain Node is enough; the api Worker's specs
// run the same code inside workerd through its routes.
export default defineConfig(() => ({
  root: import.meta.dirname,
  cacheDir: '../../../node_modules/.vite/libs/worker/github',
  plugins: [nxViteTsPaths()],
  test: {
    name: 'worker-github',
    watch: false,
    globals: true,
    environment: 'node',
    include: ['src/**/*.spec.ts'],
    reporters: ['default'],
  },
}));
