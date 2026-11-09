import type { JobRole } from './job-roles';

/**
 * Who a request to `/api/*` acts as, decided once by `authMiddleware` (ADR 0001 decision 7). Downstream code
 * reads `c.get('identity')` and never looks at Access headers itself. Only `kind` is ever logged.
 */
export type Identity =
  | { readonly kind: 'user'; readonly email: string }
  | { readonly kind: 'service'; readonly commonName: string }
  | { readonly kind: 'local' }
  /**
   * A team job (#444). Today only the local stand-in (`local-job.ts`) mints it, and only under the local bypass;
   * Phase 2 of #309 replaces that with the job-token middleware. One role, one project, the items it holds.
   */
  | {
      readonly kind: 'job';
      readonly role: JobRole;
      readonly projectSlug: string;
      readonly jobId: string;
      readonly items: readonly number[];
    };

declare module 'hono' {
  interface ContextVariableMap {
    identity: Identity;
  }
}
