import { version } from '../../../package.json';

/** Inlined by wrangler's bundler, so the deployed Worker reports the version it was built from. */
export const buildInfo = { version } as const;
