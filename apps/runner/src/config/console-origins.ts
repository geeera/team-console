/**
 * The console origins compiled into this runner (#634 S3, threat model C4 R-INT-3): each environment's
 * `CONSOLE_PUBLIC_ORIGIN` in `apps/api/wrangler.jsonc` (`console-origins.spec.ts` keeps the two equal). The
 * enrolment confirmation names the origin as the console's identity, never the account name a console reports, and
 * the `.pkg` deep link (#634 PR 6) takes no origin outside this list.
 */
export const BUILT_IN_CONSOLE_ORIGINS: readonly string[] = [
  'https://team-console-production.geeera.workers.dev',
  'https://team-console-stage.geeera.workers.dev',
  'https://team-console-dev.geeera.workers.dev',
];

/** Whether `origin` (an `apiOriginOf` result) is one this runner was built for. */
export const isBuiltInConsoleOrigin = (origin: string): boolean => BUILT_IN_CONSOLE_ORIGINS.includes(origin);
