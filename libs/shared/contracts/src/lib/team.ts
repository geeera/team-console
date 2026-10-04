/**
 * Team commands, part 1 (#114): pause / resume development and "Run now" for a slot. The Worker reads the run log
 * and fires the slot's routine; the client never decides a refusal itself, it renders the problem `type`.
 */

/** Planning (`slot-pm`), development (`slot-dev`), QA (`slot-qa`): three routines, each with its own trigger. */
export type TeamSlot = 'pm' | 'dev' | 'qa';

export const TEAM_SLOTS: readonly TeamSlot[] = ['pm', 'dev', 'qa'];

export function isTeamSlot(value: unknown): value is TeamSlot {
  return value === 'pm' || value === 'dev' || value === 'qa';
}

/** Whether both Worker secrets of a slot are set (`SLOT_TOKEN_<SLUG>_<SLOT>`, `SLOT_ROUTINE_<SLUG>_<SLOT>`). */
export type SlotSetup = 'present' | 'missing';

export type ProjectSlotsDto = Readonly<Record<TeamSlot, SlotSetup>>;

/** The longest pause reason the console accepts; it goes into the run log as the owner's words. */
export const PAUSE_REASON_MAX_LENGTH = 300;

/** `POST /api/v1/projects/:slug/team/pause`. */
export interface PauseRequest {
  readonly reason?: string;
}

/** `POST /api/v1/projects/:slug/runs`. */
export interface RunRequest {
  readonly slot: TeamSlot;
}

/**
 * Who paused: the owner (an active `pt-owner-pause` record, from the console or the team chat), or the team itself
 * (`team:paused` without one — three failed runs in a row).
 */
export type TeamState = 'running' | 'paused-by-owner' | 'paused-by-team';

/** Why a slot cannot be started now, in the order the Worker checks (architect note on #114 §4). */
export type SlotLock =
  /** The run log shows a run of this slot younger than the 3-hour overlap window. */
  | { readonly kind: 'started'; readonly runId: string; readonly since: string; readonly until: string }
  /** The console fired it; the run log does not show it yet (at most 15 minutes). */
  | { readonly kind: 'requested'; readonly since: string; readonly until: string }
  /** The fire got no answer; locked the same 15 minutes unless the run log shows the run. */
  | { readonly kind: 'unknown'; readonly since: string; readonly until: string };

export interface SlotStatusDto {
  readonly slot: TeamSlot;
  readonly setup: SlotSetup;
  /** The secret names to set when `setup` is `missing`; names only, never values. */
  readonly secrets: { readonly token: string; readonly routine: string };
  /** The latest run of the slot that ended (ISO 8601), and how. */
  readonly lastRun: { readonly at: string; readonly state: 'finished' | 'failed' | 'unknown' } | null;
  readonly lock: SlotLock | null;
}

/** `GET /api/v1/projects/:slug/team/status`: read fresh from the run log on every call. */
export interface TeamStatusDto {
  readonly state: TeamState;
  /** When the owner paused (the record's comment time); `null` unless `paused-by-owner`. */
  readonly pausedAt: string | null;
  /** The run-log issue on GitHub; `null` while the project has none. */
  readonly runLogUrl: string | null;
  /** Pause and resume write as the owner; Run now does not need this. */
  readonly ownerConnected: boolean;
  /** The Worker's environment, for the setup card's `--env`. */
  readonly environment: string;
  readonly slots: readonly SlotStatusDto[];
  /** ISO 8601: when the Worker read the run log. */
  readonly checkedAt: string;
}

/** A pause or resume written to the run log. */
export interface TeamCommandResponse {
  readonly state: TeamState;
  readonly runLogUrl: string;
  /** The run-log comment the owner's token wrote. */
  readonly commentUrl: string;
  /** Answered from the 60 s replay window, nothing written again. */
  readonly replayed: boolean;
}

/** A fired routine. */
export interface RunResponse {
  readonly slot: TeamSlot;
  readonly requestedAt: string;
  /** No second start before this, unless the run log shows the run sooner. */
  readonly lockedUntil: string;
  readonly runLogUrl: string | null;
}

/**
 * The problem `type` slugs of team commands, each with what the panel shows:
 * `run-paused` (resume first), `run-in-progress` (`runId`, `since`, `until`), `run-requested` (`since`, `until`),
 * `routine-rate-limited` (`Retry-After`), `routine-paused` (switch it on at claude.ai/code/routines),
 * `routine-not-configured` (`step: token | routine`, or `missing: [slots]`), `routine-unavailable`,
 * `routine-unknown` (`until`), `team-already-paused` / `team-not-paused` (nothing changed), `run-log-missing`,
 * `pause-unreliable` (the run log was opened by the team's bot: pause from the team chat, #141).
 */
export type TeamProblemType =
  | 'run-paused'
  | 'run-in-progress'
  | 'run-requested'
  | 'routine-rate-limited'
  | 'routine-paused'
  | 'routine-not-configured'
  | 'routine-unavailable'
  | 'routine-unknown'
  | 'team-already-paused'
  | 'team-not-paused'
  | 'team-command-in-progress'
  | 'pause-unreliable'
  | 'run-log-missing';

/**
 * The team as the plugin's `runstate` sees it (#27, #132): `paused` — the owner paused it; `failing` — the team stopped
 * itself (three failed runs in a row), or the streak is there and the next start will stop it; `unknown` — the run
 * log cannot be trusted (opened by someone outside the team, or several of them) or was not read in this request.
 */
export type TeamRunState = 'running' | 'paused' | 'failing' | 'unknown';

export const TEAM_RUN_STATES: readonly TeamRunState[] = ['running', 'paused', 'failing', 'unknown'];

export function isTeamRunState(value: unknown): value is TeamRunState {
  return typeof value === 'string' && (TEAM_RUN_STATES as readonly string[]).includes(value);
}

/**
 * One run as the board shows it (#132): `running` while its start is younger than the 3-hour overlap window,
 * `failed` when it failed or died (a start older than the window), `unknown` whenever a team entry of the run was
 * edited after the fact (REST cannot prove an edit harmless) or the plugin wrote a state the console does not know.
 * An edited entry is never shown as `failed`.
 */
export type RunEntryState = 'running' | 'finished' | 'failed' | 'unknown';

export const RUN_ENTRY_STATES: readonly RunEntryState[] = ['running', 'finished', 'failed', 'unknown'];

export function isRunEntryState(value: unknown): value is RunEntryState {
  return typeof value === 'string' && (RUN_ENTRY_STATES as readonly string[]).includes(value);
}

/** How many of the latest runs the board lists. */
export const RECENT_RUNS_LIMIT = 5;

export interface RecentRunDto {
  /** The console's slot for the run-log slot name; `null` for a slot the console has no name for. */
  readonly slot: TeamSlot | null;
  /** The slot as the run log writes it (`slot-dev`): team text, shown only as plain text. */
  readonly slotName: string;
  readonly state: RunEntryState;
  /** ISO 8601: when the run ended, or when it started while it runs; `null` when GitHub sent no time. */
  readonly at: string | null;
}

/** The team's run state and its latest runs, newest first (at most `RECENT_RUNS_LIMIT`). */
export interface TeamRunDto {
  readonly state: TeamRunState;
  /** The run-log issue on GitHub; `null` while the project has none or it could not be read. */
  readonly runLogUrl: string | null;
  readonly recentRuns: readonly RecentRunDto[];
}
