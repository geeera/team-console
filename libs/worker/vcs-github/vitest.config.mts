/// <reference types='vitest' />
import { nxViteTsPaths } from '@nx/vite/plugins/nx-tsconfig-paths.plugin';
import { defineConfig } from 'vitest/config';

// Over fetch and Web Crypto, both global in Node 22, against @worker/github's mock GitHub; the api and hooks
// Workers' specs run the same code inside workerd through their routes.
export default defineConfig(() => ({
  root: import.meta.dirname,
  cacheDir: '../../../node_modules/.vite/libs/worker/vcs-github',
  plugins: [nxViteTsPaths()],
  test: {
    name: 'worker-vcs-github',
    watch: false,
    globals: true,
    environment: 'node',
    include: ['src/**/*.spec.ts'],
    reporters: ['default'],
  },
}));
