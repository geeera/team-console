import { version } from '../../../../package.json';

/** Replaced by the `define` option of the production build; absent in dev and tests. */
declare const __TC_BUILT_AT__: string | undefined;

export const buildInfo = {
  version,
  builtAt: typeof __TC_BUILT_AT__ === 'string' ? __TC_BUILT_AT__ : 'local',
} as const;
