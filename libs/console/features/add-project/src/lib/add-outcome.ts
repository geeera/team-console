import type { HttpProblem } from '@console/shared/api';
import { refusedSetupSteps, type SetupStep } from '@console/entities/project';
import { isGitHubLogin, isGitHubPageUrl } from '@shared/contracts';

/** What New project shows after a check; `checking` while the Worker runs it. */
export type AddOutcome =
  | { readonly kind: 'checking' }
  | {
      readonly kind: 'refused';
      readonly steps: readonly SetupStep[];
      readonly installUrl: string | null;
      readonly repoOwner: string | null;
      readonly login: string | null;
    }
  | { readonly kind: 'unavailable'; readonly reason: 'github' | 'auth' }
  | { readonly kind: 'unavailable'; readonly reason: 'rate'; readonly retryAt: string }
  /** No usable owner connection on the Worker (403): nothing was saved, connect first. */
  | { readonly kind: 'not-connected' }
  /** 409 `project-exists`: which project holds the repository is looked up next. */
  | { readonly kind: 'exists' }
  | { readonly kind: 'duplicate'; readonly slug: string }
  | { readonly kind: 'archived' }
  /** 422 on the request itself: shown on the field, like a client-side format error. */
  | { readonly kind: 'invalid' };

// Without Retry-After the Worker's own default applies; GitHub's docs say to wait at least a minute.
const DEFAULT_RETRY_SECONDS = 60;

function stringMember(problem: HttpProblem, key: string): unknown {
  return problem.extensions[key];
}

/**
 * Maps a refused `POST /api/v1/projects` to New project's outcome, from the problem's `type` and `step` members
 * (#15) — never from `detail`. Anything not recognised is "GitHub didn't respond": nothing was saved either way.
 */
export function addOutcomeOf(problem: HttpProblem, now: number = Date.now()): AddOutcome {
  switch (problem.slug) {
    case 'validation':
      return { kind: 'invalid' };
    case 'project-exists':
      return { kind: 'exists' };
    case 'github-owner-not-connected':
      return { kind: 'not-connected' };
    case 'github-rate-limit': {
      const seconds = problem.retryAfterSeconds ?? DEFAULT_RETRY_SECONDS;
      return { kind: 'unavailable', reason: 'rate', retryAt: new Date(now + seconds * 1000).toISOString() };
    }
    case 'github-auth':
      return { kind: 'unavailable', reason: 'auth' };
    case 'github-app-not-installed':
    case 'github-owner-mismatch':
    case 'project-yml-missing': {
      const steps = refusedSetupSteps(stringMember(problem, 'step'));
      if (steps === null) {
        return { kind: 'unavailable', reason: 'github' };
      }
      const installUrl = stringMember(problem, 'installUrl');
      const repoOwner = stringMember(problem, 'repoOwner');
      const login = stringMember(problem, 'login');
      return {
        kind: 'refused',
        steps,
        installUrl: isGitHubPageUrl(installUrl) ? installUrl : null,
        repoOwner: isGitHubLogin(repoOwner) ? repoOwner : null,
        login: isGitHubLogin(login) ? login : null,
      };
    }
    default:
      return { kind: 'unavailable', reason: 'github' };
  }
}
