import type { RunnerCapabilitiesDto, RunnerIsolation } from '@shared/contracts';
import type { Membership } from '@worker/db';
import type { JobRole } from './job-roles';

/**
 * Who a request to `/api/*` acts as, decided once by `authMiddleware` (ADR 0001 decision 7). Downstream code
 * reads `c.get('identity')` and never looks at Access headers or cookies itself. Only `kind` is ever logged.
 */
export type Identity =
  /**
   * A signed-in person (ADR 0008 decision 3, #466). `door` says which seam minted it: `access` is the environment's
   * owner behind the Cloudflare Access perimeter (`OWNER_EMAIL`), `session` the console's own `__Host-tc_session`
   * cookie. `memberships` is the scope (decision 2), read from D1 per request and never from the cookie. `userId`
   * is `null` only for the Access owner before the explicit link of decision 3 and without the 0018 owner row.
   */
  | {
      readonly kind: 'user';
      readonly door: 'access' | 'session';
      readonly userId: string | null;
      readonly memberships: readonly Membership[];
    }
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
      /**
       * `token`: the opaque `tcj_` job token of a claimed job, presented with the claiming runner's JWT (#467,
       * `job-auth.ts`) — valid in every environment. `stand-in`: the local `local-job.` token (#444), honoured under
       * the local bypass alone; absent (a forged identity) reads as a stand-in and is refused off the bypass.
       */
      readonly source?: 'token' | 'stand-in';
    }
  /**
   * An enrolled runner on `/api/v1/runner/*` (#467, ADR 0008 decision 2): its EdDSA JWT alone mints it
   * (`runner-auth.ts`). Its scope is `allowedProjects` inside `accountId`, never the account itself.
   */
  | {
      readonly kind: 'runner';
      readonly runnerId: string;
      readonly accountId: string;
      readonly allowedProjects: readonly string[];
      readonly isolation: RunnerIsolation;
      readonly capabilities: RunnerCapabilitiesDto;
    }
  /**
   * `POST /api/v1/runner/enrol` only: no identity yet — the one-time code in the body is the credential, judged by
   * the route. Carries no ambient authority, so the CSRF rules for cookie-borne identities do not apply to it.
   */
  | { readonly kind: 'enrolment' };

declare module 'hono' {
  interface ContextVariableMap {
    identity: Identity;
  }
}
