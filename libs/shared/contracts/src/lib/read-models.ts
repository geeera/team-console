import type { AnswerCommand, Section } from './answer';

/**
 * Read models of a product repository (#35): what the owner's inbox, the questions list, the sprint board and
 * the cross-project "Needs you" show. Built in the api Worker from GitHub reads; no GitHub type crosses the wire.
 *
 * Every title, body and `ask` is untrusted issue text, passed through verbatim: the client renders it as plain
 * text (Angular interpolation), never as HTML. Every `url` is `https://github.com/…` or `null`.
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
}

/** `metrics.sprint_summary`'s per-tier row. */
export interface SprintTierRowDto {
  readonly planned: number;
  readonly shipped: number;
  readonly raised: number;
}

export interface SprintPullRequestDto {
  readonly number: number;
  readonly title: string;
  readonly url: string | null;
  readonly draft: boolean;
  readonly authorTrusted: boolean;
}

/** `GET /api/v1/projects/:slug/sprint`: the current sprint (`calendar.pick_current_sprint`) and its numbers. */
export interface SprintDto {
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
