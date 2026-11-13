/** Stamped by `build.mjs` from `TC_RUNNER_VERSION` (the release workflow passes the tag); absent in specs and dev builds. */
declare const __TC_RUNNER_VERSION__: string | undefined;

/** This build's release label, posted at enrolment and compared by `update` (ADR 0008 decision 10). */
export const RUNNER_VERSION: string =
  typeof __TC_RUNNER_VERSION__ === 'string' ? __TC_RUNNER_VERSION__ : '0.1.0-dev';
