// The public part of `frame-src.ts` (the barrel re-exports whole files, #123): `trustedFrameSrc` stays inside the
// kit, reached only through `Frame`.
export { FRAME_HOST_SUFFIXES, externalHrefOf, frameSrcOf } from './frame-src';
