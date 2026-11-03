import type { StorybookConfig } from '@analogjs/storybook-angular';
import { nxViteTsPaths } from '@nx/vite/plugins/nx-tsconfig-paths.plugin';
import { mergeConfig, type UserConfig } from 'vite';

/**
 * Vite-built Storybook for the kit (the Analog framework reuses the same Angular Vite plugin as
 * the unit tests, so the workspace carries no webpack build of its own).
 */
const config: StorybookConfig = {
  // Widget presenters whose states are part of a design (#194), the design preview and the viewer (#277) and the
  // question card's previews (#276) sit next to the kit.
  stories: [
    '../src/lib/**/*.stories.ts',
    '../../../widgets/github-repositories/src/**/*.stories.ts',
    '../../../widgets/question-list/src/**/*.stories.ts',
    '../../../entities/design/src/**/*.stories.ts',
    '../../../features/design-viewer/src/**/*.stories.ts',
  ],
  // One design render on the api's file route, so the preview and viewer stories show a real image (#277).
  staticDirs: [{ from: './public', to: '/' }],
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
