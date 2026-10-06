import type { StorybookConfig } from '@analogjs/storybook-angular';
import { nxViteTsPaths } from '@nx/vite/plugins/nx-tsconfig-paths.plugin';
import { mergeConfig, type UserConfig } from 'vite';

/**
 * Vite-built Storybook for the kit (the Analog framework reuses the same Angular Vite plugin as
 * the unit tests, so the workspace carries no webpack build of its own).
 */
const config: StorybookConfig = {
  // Widget presenters whose states are part of a design (#194) sit next to the kit.
  stories: ['../src/lib/**/*.stories.ts', '../../../widgets/github-repositories/src/**/*.stories.ts'],
  addons: ['@storybook/addon-a11y'],
  framework: {
    name: '@analogjs/storybook-angular',
    options: { tsconfig: 'libs/console/shared/ui/.storybook/tsconfig.json' },
  },
  core: { disableTelemetry: true },
  viteFinal(viteConfig: UserConfig) {
    return mergeConfig(viteConfig, { plugins: [nxViteTsPaths()] });
  },
};

export default config;
