import type { ProblemDetails } from './problem-details';
import type { SnoozeDto } from './snooze';
import type { ProjectSlotsDto } from './team';

/** A registered product repository (ADR 0001, decision 20) as the client sees it. */
export interface ProjectDto {
  readonly slug: string;
  /** `owner/name` on GitHub. */
  readonly repo: string;
  readonly displayName: string;
  /** `trig_…` of the project's PM-chat routine, once set in Settings. */
  readonly routineId: string | null;
  /** ISO 8601 UTC. */
  readonly addedAt: string;
  /** ISO 8601 UTC; only `?include=archived` lists archived projects. */
  readonly archivedAt: string | null;
  /**
   * Whether "Run now" is set up per slot (#114): both `SLOT_TOKEN_<SLUG>_<SLOT>` and `SLOT_ROUTINE_<SLUG>_<SLOT>`.
   * Set on every answer of the registry routes; optional only so DTOs built elsewhere need not invent it.
   */
  readonly slots?: ProjectSlotsDto;
  /** Snoozed notifications (#221), for the sidebar's bell; set by the registry routes like `slots`. */
  readonly snooze?: SnoozeDto;
}

/** `POST /api/v1/projects`. The slug defaults to the repository name in kebab case. */
export interface AddProjectRequest {
  readonly repo: string;
  readonly displayName?: string;
  readonly slug?: string;
}

/** `PATCH /api/v1/projects/:slug`; `routineId: null` clears it. */
export interface UpdateProjectRequest {
  readonly displayName?: string;
  readonly routineId?: string | null;
}

/**
 * What a refused add names in the problem's `step` member (#15), in the order the Worker checks: the request
 * itself, the registry, then GitHub. The Settings screen (#24) maps it to its checklist without parsing `detail`.
 */
export type AddProjectStep =
  'repo-format' | 'slug' | 'display-name' | 'unique' | 'app-installed' | 'repo-owner' | 'project-yml';

/** A refused add or setup check: Problem Details plus the step and, where the owner can act, a link. */
export interface ProjectStepProblem extends ProblemDetails {
  readonly step: AddProjectStep;
  /** `github-app-not-installed`: the app's install page on GitHub. */
  readonly installUrl?: string;
  /** `github-owner-not-connected`: the console route that starts the owner connection (#59). */
  readonly connectUrl?: string;
  /** `github-owner-mismatch`: the repository owner's login as GitHub spells it (#24 copy). */
  readonly repoOwner?: string;
  /** `github-owner-mismatch`: the connected account's login (#24 copy). */
  readonly login?: string;
}

/**
 * `GET /api/v1/projects/:slug/setup` — the five steps of the Settings checklist (#24) plus what it shows
 * around them. Steps 1–3 gate adding; `events` and `routineToken` are informational.
 *
 * `unknown` (#83) is a GitHub read that failed on its own (rate limit, outage, …) for that step only: the
 * request still answers 200 with whatever else it does know, instead of failing as a whole.
 */
export interface ProjectSetupDto {
  readonly appInstalled: 'ok' | 'missing' | 'unknown';
  /** `not-checked` while the app is not installed or no account is connected. */
  readonly repoOwner: 'ok' | 'mismatch' | 'not-checked' | 'unknown';
  /** `missing` also when the app is not installed: the file cannot be read then. */
  readonly projectYml: 'ok' | 'missing' | 'unknown';
  /** Any app webhook delivery for the repository (#12); `never` before the deliveries table exists. */
  readonly events: 'seen' | 'never';
  /** ISO 8601 UTC of the most recent delivery (#12); `null` while `events` is `never`. */
  readonly lastEventAt: string | null;
  /** The Worker secret `ROUTINE_TOKEN_<SLUG>` is set; its value never leaves the Worker. */
  readonly routineToken: 'present' | 'missing';
  readonly connection:
    { readonly state: 'connected'; readonly login: string } | { readonly state: 'not-connected' };
  /** ISO 8601 UTC; set by #12 when the app lost access to the repository. */
  readonly accessLostAt: string | null;
  /** `owner.language` of the project's `.product-team/project.yml`; `ru` when absent. */
  readonly ownerLanguage: 'ru' | 'en';
  /** The app's install page for this environment (#83), present only while `appInstalled` is `missing`. */
  readonly installUrl?: string;
  /** The repository owner's login as GitHub spells it, present once it was read (`repoOwner` ok or mismatch). */
  readonly repoOwnerLogin?: string;
}
