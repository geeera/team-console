import type { NeedsYouProjectProblem } from './read-models';
import type { SnoozeDto } from './snooze';
import type { TeamRunState } from './team';

/**
 * The all-projects overview (#27, ADR 0001 decision 24): one row per active project, read-only. Built in the api
 * Worker from the same reads as "Needs you", the sprint board and the team status; no GitHub type crosses the wire.
 * The sprint title is untrusted milestone text: the client renders it as plain text only.
 */

/** The team as the plugin's `runstate` sees it; the sprint board shows the same state (#132). */
export type OverviewTeamState = TeamRunState;

export interface OverviewSprintDto {
  readonly number: number;
  readonly title: string;
  /** Demo day, `YYYY-MM-DD` (the milestone's due date). */
  readonly dueOn: string;
  /** Work items (`kind:feature|bug|chore|finding`) of the sprint and those of them closed, as the board counts them. */
  readonly planned: number;
  readonly shipped: number;
}

/** A project whose reads all answered. */
export interface OverviewProjectReadDto {
  readonly kind: 'read';
  readonly slug: string;
  readonly name: string;
  readonly team: OverviewTeamState;
  /** `null`: no open milestone is due today or later. */
  readonly sprint: OverviewSprintDto | null;
  /** Issue numbers waiting for the owner (the inbox); the client leaves out the ones it just answered. */
  readonly needsYou: readonly number[];
  /** "Security setup": `team.reviewer_logins` in project.yml is empty. */
  readonly setup: boolean;
  readonly setupUrl: string | null;
  /** The project's snoozed notifications (#221) from the registry row, as the card's bell line shows them (#222). */
  readonly snooze: SnoozeDto;
}

/**
 * A project that could not be read in this request; the other rows are unaffected. `github-request-budget`: the
 * request's subrequest budget ran out before this project was read — the next request continues from the cache.
 */
export interface OverviewProjectFailedDto {
  readonly kind: 'failed';
  readonly slug: string;
  readonly name: string;
  readonly problem: NeedsYouProjectProblem;
}

export type OverviewProjectDto = OverviewProjectReadDto | OverviewProjectFailedDto;

/** `GET /api/v1/overview`: every active project in registry order. */
export interface OverviewDto {
  readonly projects: readonly OverviewProjectDto[];
  /** ISO 8601: when the Worker answered. */
  readonly checkedAt: string;
}
