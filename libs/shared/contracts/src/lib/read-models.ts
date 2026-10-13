import type { AnswerCommand, Section } from './answer';
import type { OwnerCategory, TeamRecommendation } from './batch-answer';
import type { TeamRunDto } from './team';
import type { OwnerRequestStatusDto } from './owner-request';

/**
 * Read models of a product repository (#35): what the owner's inbox, the questions list, the sprint board and
 * the cross-project "Needs you" show. Built in the api Worker from GitHub reads; no GitHub type crosses the wire.
 *
 * Every title, body and `ask` is untrusted issue text: the client renders it as plain text (Angular interpolation),
 * never as HTML. Bodies and `ask` pass through verbatim; every `title` has its invisible characters (controls,
 * zero-width, bidi marks and overrides, fillers, tag characters) removed by `withoutInvisibles` in the builder, so
 * an outsider's item cannot pose as another (#287). Every `url` is `https://github.com/…` or `null`.
 */

/** One issue waiting for the owner, as the plugin's inbox lists it (`brief.needs`). */
export interface InboxItemDto {
  readonly section: Section;
  readonly number: number;
  readonly title: string;
  readonly url: string | null;
  /** The answer line ("**Your answer:** …") — the team's recommendation; `null` when the issue has none. */
  readonly ask: string | null;
  /**
   * The issue's author is the repository owner, a member or a collaborator (`author_association`), or the team's
   * own app `team-console-team[bot]` (owner decision on #35). Anyone who can open an issue can get one labelled
   * through a template, so an untrusted item is shown marked (#9 threat row 5).
   */
  readonly authorTrusted: boolean;
  /** The owner decision a question is about, from its `owner:*` label (`categoryOf`); `null` without one. */
  readonly category: OwnerCategory | null;
  /**
   * The command of the one option the answer line marks "(…, recommended)" / "(рекомендую)" / "(рекомендуем)";
   * `null` for anything else (`recommendationOf`, fails closed). Read from untrusted text: only the server's re-check
   * decides what a batch may answer.
   */
  readonly recommendation: TeamRecommendation | null;
  /**
   * What a card needs to decide without GitHub (#276), read from the body's fixed `##` sections; `null` when the
   * author is not trusted (outsiders' bodies are never parsed into the card) or nothing readable was found.
   */
  readonly context: QuestionContextDto | null;
}

/**
 * The fixed sections of a team question's body (#276), each as bounded plain text: markup, tag-like runs and
 * invisible characters are removed for readability, not as sanitising (`<scr<x>ipt>` comes out as `<script>`, #288).
 * Untrusted text for interpolation only — never pass a field to tc-markdown or innerHTML. A missing section is `null`;
 * the card hides its slot.
 */
export interface QuestionContextDto {
  /** `## Кратко` / `## Summary`: one line, the card's title in the owner's language. */
  readonly summary: string | null;
  /** `## Вопрос` / `## Question`; without any section heading, the body's first paragraph. */
  readonly question: string | null;
  /** `## Почему` / `## Why`: the reason behind the team's recommendation. */
  readonly why: string | null;
  /** `## Если одобрить` / `## If approved`. */
  readonly ifApproved: string | null;
  /** `## Если отклонить` / `## If rejected`. */
  readonly ifRejected: string | null;
  /** `## Цена и риск` / `## Cost and risk`. */
  readonly costAndRisk: string | null;
  /** The body has at least one of the sections; `false` means the card falls back to the answer line's options. */
  readonly structured: boolean;
}

/** `GET /api/v1/projects/:slug/inbox`: the plugin's inbox for one repository, in its order. */
export interface InboxDto {
  readonly items: readonly InboxItemDto[];
  /** "Security setup": the agents can act as the owner while `team.reviewer_logins` in project.yml is empty. */
  readonly setup: boolean;
  /** The owner checklist while `setup` is true, else `null`. */
  readonly setupUrl: string | null;
  /** The team is paused (`team:paused` on an open issue, the run log); `/resume` there continues it. */
  readonly paused: boolean;
  readonly pausedUrl: string | null;
}

/** A question card: an inbox item with its body and the answers the owner grammar allows for it. */
export interface QuestionDto extends InboxItemDto {
  readonly body: string;
  readonly allowedCommands: readonly AnswerCommand[];
}

/** `GET /api/v1/projects/:slug/questions`. */
export interface QuestionsDto {
  readonly items: readonly QuestionDto[];
}

export type SprintTier = 'light' | 'standard' | 'heavy';

export interface SprintMilestoneDto {
  readonly number: number;
  readonly title: string;
  /** Demo day, `YYYY-MM-DD` (the milestone's due date). */
  readonly dueOn: string;
  readonly url: string | null;
}

export interface SprintIssueDto {
  readonly number: number;
  readonly title: string;
  readonly url: string | null;
  readonly state: 'open' | 'closed';
  /** The `status:*` label without the prefix; `null` when there is none. */
  readonly status: string | null;
  /** The architect's `tier:*` as the plugin reads it (`standard` when missing or ambiguous). */
  readonly tier: SprintTier;
  readonly kind: string | null;
  readonly authorTrusted: boolean;
  /**
   * The owner's newest request to the PM on this issue (#219), from the console's D1 record. Set by the sprint route
   * only; absent elsewhere (the overview reads no requests).
   */
  readonly request?: OwnerRequestStatusDto | null;
}

/** `metrics.sprint_summary`'s per-tier row. */
export interface SprintTierRowDto {
  readonly planned: number;
  readonly shipped: number;
  readonly raised: number;
}

/**
 * The CI of a pull request's head commit (#131), combined from its check runs: `failure` when any run failed,
 * else `pending` while any has not finished, else `success`; `none` when the head has no check run. `unknown`:
 * not read in this request (the subrequest budget, or GitHub refused the read) — never an error of the board.
 */
export type SprintCiState = 'success' | 'failure' | 'pending' | 'none' | 'unknown';

export const SPRINT_CI_STATES: readonly SprintCiState[] = [
  'success',
  'failure',
  'pending',
  'none',
  'unknown',
];

export function isSprintCiState(value: unknown): value is SprintCiState {
  return typeof value === 'string' && (SPRINT_CI_STATES as readonly string[]).includes(value);
}

export interface SprintPullRequestDto {
  readonly number: number;
  readonly title: string;
  readonly url: string | null;
  readonly draft: boolean;
  readonly authorTrusted: boolean;
  readonly ci: SprintCiState;
}

/**
 * `GET /api/v1/projects/:slug/embed-origins` (#20): the only origins the console may frame for this project, those of
 * `design.storybook_url` in its project.yml (stage is link-only: it is behind Cloudflare Access, owner decision
 * 2026-10-05), `https:` only, never the console's own origin, as exact origins. Read per
 * project when a space needs it, never on the registry list.
 */
export interface EmbedOriginsDto {
  readonly embedOrigins: readonly string[];
}

/** The current sprint (`calendar.pick_current_sprint`) and its numbers, as read from the repository's lists. */
export interface SprintListsDto {
  /** `null` when no open milestone has a due date today or later; the rest is then empty. */
  readonly milestone: SprintMilestoneDto | null;
  readonly issues: readonly SprintIssueDto[];
  /** Issues of the sprint per status label (`none` for an issue without one), open and closed. */
  readonly byStatus: Readonly<Record<string, number>>;
  /** Work items (`kind:feature|bug|chore|finding`) planned, done, still open; per tier (`unsized` without one). */
  readonly planned: number;
  readonly shipped: number;
  readonly carriedOver: number;
  readonly byTier: Readonly<Record<string, SprintTierRowDto>>;
  /** The repository's open pull requests (up to 100). */
  readonly openPullRequests: readonly SprintPullRequestDto[];
}

/** `GET /api/v1/projects/:slug/sprint`: the sprint's lists, and the team's run state from the run log (#132). */
export interface SprintDto extends SprintListsDto {
  readonly team: TeamRunDto;
}

export interface NeedsYouProjectRef {
  readonly slug: string;
  readonly name: string;
}

export interface NeedsYouItemDto extends InboxItemDto {
  readonly project: NeedsYouProjectRef;
  readonly allowedCommands: readonly AnswerCommand[];
}

/** Why one project's inbox is missing from "Needs you"; the others are still listed. */
export interface NeedsYouProjectProblem {
  /** The problem type slug, e.g. `github-app-not-installed`, `project-config-invalid`. */
  readonly type: string;
  readonly title: string;
  readonly status: number;
}

export interface NeedsYouProjectDto extends NeedsYouProjectRef {
  readonly setup: boolean;
  readonly setupUrl: string | null;
  readonly paused: boolean;
  readonly pausedUrl: string | null;
  /** `null` when the project's inbox was read. */
  readonly problem: NeedsYouProjectProblem | null;
}

/**
 * `GET /api/v1/needs-you`: every active project's inbox, items sorted by inbox order, then project (registry
 * order), then issue number. At most `NEEDS_YOU_MAX_PROJECTS` projects are read per request (subrequest budget).
 */
export interface NeedsYouDto {
  readonly items: readonly NeedsYouItemDto[];
  readonly projects: readonly NeedsYouProjectDto[];
  /** Active projects beyond the cap, not read in this request (registry order). */
  readonly omittedProjects: readonly NeedsYouProjectRef[];
}

/** Projects "Needs you" reads per request; see `apps/api/src/routes/needs-you.ts` for the subrequest budget. */
export const NEEDS_YOU_MAX_PROJECTS = 6;
