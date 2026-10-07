import type {
  OwnerRequestState,
  OwnerRequestStatusDto,
  RecentRunDto,
  RunEntryState,
  SprintCiState,
  SprintDto,
  SprintIssueDto,
  SprintMilestoneDto,
  SprintPullRequestDto,
  SprintTier,
  TeamRunDto,
  TeamRunState,
  TeamSlot,
} from '@shared/contracts';
import {
  isGitHubPageUrl,
  isOwnerRequest,
  isOwnerRequestState,
  isRunEntryState,
  isSprintCiState,
  isTeamRunState,
  isTeamSlot,
  RECENT_RUNS_LIMIT,
} from '@shared/contracts';

/**
 * The current sprint as the board shows it, from `GET /api/v1/projects/:slug/sprint` (#35). Every title is untrusted
 * GitHub text and is rendered as plain text only; every `url` is a github.com page or `null`.
 */
export interface SprintIssue {
  readonly number: number;
  readonly title: string;
  readonly url: string | null;
  readonly state: 'open' | 'closed';
  /** The `status:*` label without the prefix; `null` without one. */
  readonly status: string | null;
  readonly tier: SprintTier;
  readonly kind: string | null;
  readonly authorTrusted: boolean;
  /** The owner's newest request to the PM on it (#219); `null` without one. */
  readonly request: SprintIssueRequest | null;
}

/** What the board row says about the owner's request: the «waiting for the PM» badge while pending. */
export interface SprintIssueRequest {
  readonly state: OwnerRequestState;
  readonly kind: 'sprint' | 'priority';
}

export interface SprintPullRequest {
  readonly number: number;
  readonly title: string;
  readonly url: string | null;
  readonly draft: boolean;
  readonly authorTrusted: boolean;
  /** The head commit's CI (#131); `unknown` when the server could not read it in this load. */
  readonly ci: SprintCiState;
}

/**
 * The "CI" tile (#131): the state that matters most across the open pull requests and how many are in it —
 * any failing first, then running, then not read, then passing; `empty` without an open pull request.
 */
export interface SprintCiSummary {
  readonly state: SprintCiState | 'empty';
  readonly count: number;
}

/** Most urgent first: what the owner should look at before anything else. */
const CI_URGENCY: readonly SprintCiState[] = ['failure', 'pending', 'unknown', 'success', 'none'];

export function ciSummaryOf(pulls: readonly SprintPullRequest[]): SprintCiSummary {
  for (const state of CI_URGENCY) {
    const count = pulls.filter((pull) => pull.ci === state).length;
    if (count > 0) {
      return { state, count };
    }
  }
  return { state: 'empty', count: 0 };
}

/** One of the team's latest runs (#132); `slotName` is team text from the run log, shown as plain text only. */
export interface SprintRun {
  readonly slot: TeamSlot | null;
  readonly slotName: string;
  readonly state: RunEntryState;
  /** ISO 8601; `null` when GitHub sent no time. */
  readonly at: string | null;
}

/** The "Run log" tile and the latest runs (#132), as the plugin's `runstate` reads the run log. */
export interface SprintTeam {
  readonly state: TeamRunState;
  /** The run-log issue on github.com; `null` without one. */
  readonly runLogUrl: string | null;
  /** Newest first, at most `RECENT_RUNS_LIMIT`. */
  readonly recentRuns: readonly SprintRun[];
}

export interface SprintMilestone {
  readonly number: number;
  readonly title: string;
  /** Demo day, `YYYY-MM-DD`. */
  readonly dueOn: string;
  readonly url: string | null;
}

/** One status lane; `status` is the label without the prefix, or `NO_STATUS`. */
export interface StatusColumn {
  readonly status: string;
  readonly issues: readonly SprintIssue[];
}

export interface SprintBoard {
  /** `null`: no open milestone is due today or later — there is no current sprint. */
  readonly milestone: SprintMilestone | null;
  readonly issues: readonly SprintIssue[];
  /** Work items (`kind:feature|bug|chore|finding`) planned, shipped and still open, as `sprint-metrics` counts them. */
  readonly planned: number;
  readonly shipped: number;
  readonly carriedOver: number;
  readonly pullRequests: readonly SprintPullRequest[];
  readonly team: SprintTeam;
}

/** The lane of an issue without a `status:*` label — the key `backlog list` / the read model count it under. */
export const NO_STATUS = 'none';

/** The plugin's workflow order (reference/workflow.md → Status); a lane for any other label follows these. */
export const STATUS_ORDER: readonly string[] = [
  'proposed',
  'approved',
  'in-progress',
  'qa',
  'blocked',
  'done',
];

/** Lanes shown even when empty, so "nothing in QA" reads as a fact rather than a missing lane. */
export const CORE_STATUSES: readonly string[] = ['approved', 'in-progress', 'qa', 'done'];

/** The plugin's issue tiers, lightest first (the board's legend reads them in this order). */
export const SPRINT_TIERS: readonly SprintTier[] = ['light', 'standard', 'heavy'];

const TIERS: ReadonlySet<string> = new Set<string>(SPRINT_TIERS);
const DUE_DAY = /^\d{4}-\d{2}-\d{2}$/;
const DAY_MS = 24 * 60 * 60 * 1000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNullableString(value: unknown): value is string | null {
  return value === null || typeof value === 'string';
}

function isCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function isIssueNumber(value: unknown): value is number {
  return isCount(value) && value > 0;
}

function isMilestone(value: unknown): value is SprintMilestoneDto {
  return (
    isRecord(value) &&
    isIssueNumber(value['number']) &&
    typeof value['title'] === 'string' &&
    typeof value['dueOn'] === 'string' &&
    DUE_DAY.test(value['dueOn']) &&
    isNullableString(value['url'])
  );
}

function isIssue(value: unknown): value is SprintIssueDto {
  return (
    isRecord(value) &&
    isIssueNumber(value['number']) &&
    typeof value['title'] === 'string' &&
    isNullableString(value['url']) &&
    (value['state'] === 'open' || value['state'] === 'closed') &&
    isNullableString(value['status']) &&
    typeof value['tier'] === 'string' &&
    TIERS.has(value['tier']) &&
    isNullableString(value['kind']) &&
    typeof value['authorTrusted'] === 'boolean' &&
    (value['request'] === undefined || value['request'] === null || isRequestStatus(value['request']))
  );
}

/** The request's own fields are checked; its display fields only for their type. */
function isRequestStatus(value: unknown): value is OwnerRequestStatusDto {
  if (!isRecord(value)) {
    return false;
  }
  const { state, requestedAt, url, handledAt, ...request } = value;
  return (
    isOwnerRequestState(state) &&
    typeof requestedAt === 'string' &&
    typeof url === 'string' &&
    isNullableString(handledAt) &&
    isOwnerRequest(request)
  );
}

function isPullRequest(value: unknown): value is SprintPullRequestDto {
  return (
    isRecord(value) &&
    isIssueNumber(value['number']) &&
    typeof value['title'] === 'string' &&
    isNullableString(value['url']) &&
    typeof value['draft'] === 'boolean' &&
    typeof value['authorTrusted'] === 'boolean' &&
    isSprintCiState(value['ci'])
  );
}

function isRecentRun(value: unknown): value is RecentRunDto {
  return (
    isRecord(value) &&
    (value['slot'] === null || isTeamSlot(value['slot'])) &&
    typeof value['slotName'] === 'string' &&
    isRunEntryState(value['state']) &&
    isNullableString(value['at'])
  );
}

function isTeamRun(value: unknown): value is TeamRunDto {
  return (
    isRecord(value) &&
    isTeamRunState(value['state']) &&
    isNullableString(value['runLogUrl']) &&
    Array.isArray(value['recentRuns']) &&
    value['recentRuns'].every(isRecentRun)
  );
}

export function isSprintDto(value: unknown): value is SprintDto {
  return (
    isRecord(value) &&
    (value['milestone'] === null || isMilestone(value['milestone'])) &&
    Array.isArray(value['issues']) &&
    value['issues'].every(isIssue) &&
    isRecord(value['byStatus']) &&
    Object.values(value['byStatus']).every(isCount) &&
    isCount(value['planned']) &&
    isCount(value['shipped']) &&
    isCount(value['carriedOver']) &&
    isRecord(value['byTier']) &&
    Array.isArray(value['openPullRequests']) &&
    value['openPullRequests'].every(isPullRequest) &&
    isTeamRun(value['team'])
  );
}

/** The server already allows only github.com links; the client does not take that on trust. */
function safeUrl(url: string | null): string | null {
  return isGitHubPageUrl(url) ? url : null;
}

export function sprintBoardOf(dto: SprintDto): SprintBoard {
  return {
    milestone:
      dto.milestone === null
        ? null
        : {
            number: dto.milestone.number,
            title: dto.milestone.title,
            dueOn: dto.milestone.dueOn,
            url: safeUrl(dto.milestone.url),
          },
    issues: dto.issues.map((issue) => ({
      number: issue.number,
      title: issue.title,
      url: safeUrl(issue.url),
      state: issue.state,
      status: issue.status,
      tier: issue.tier,
      kind: issue.kind,
      authorTrusted: issue.authorTrusted,
      request:
        issue.request === undefined || issue.request === null
          ? null
          : { state: issue.request.state, kind: issue.request.kind },
    })),
    planned: dto.planned,
    shipped: dto.shipped,
    carriedOver: dto.carriedOver,
    pullRequests: dto.openPullRequests.map((pull) => ({
      number: pull.number,
      title: pull.title,
      url: safeUrl(pull.url),
      draft: pull.draft,
      authorTrusted: pull.authorTrusted,
      ci: pull.ci,
    })),
    team: {
      state: dto.team.state,
      runLogUrl: safeUrl(dto.team.runLogUrl),
      // The server sends at most five; the board never lists more, whatever it is sent.
      recentRuns: dto.team.recentRuns.slice(0, RECENT_RUNS_LIMIT).map((run) => ({
        slot: run.slot,
        slotName: run.slotName,
        state: run.state,
        at: run.at,
      })),
    },
  };
}

function laneRank(status: string): number {
  const known = STATUS_ORDER.indexOf(status);
  if (known !== -1) {
    return known;
  }
  return status === NO_STATUS ? STATUS_ORDER.length + 1 : STATUS_ORDER.length;
}

/**
 * Issues grouped into status lanes, counted exactly as `backlog list` / the read model's `byStatus` count them (one
 * lane per first `status:*` label, `none` without one), in workflow order; within a lane, by issue number. The core
 * lanes are always present; any other lane only when it has an issue.
 */
export function statusColumnsOf(issues: readonly SprintIssue[]): StatusColumn[] {
  const lanes = new Map<string, SprintIssue[]>(CORE_STATUSES.map((status) => [status, []]));
  for (const issue of issues) {
    const status = issue.status ?? NO_STATUS;
    const lane = lanes.get(status);
    if (lane === undefined) {
      lanes.set(status, [issue]);
    } else {
      lane.push(issue);
    }
  }
  return [...lanes.entries()]
    .sort(([a], [b]) => laneRank(a) - laneRank(b) || a.localeCompare(b))
    .map(([status, laneIssues]) => ({
      status,
      issues: [...laneIssues].sort((a, b) => a.number - b.number),
    }));
}

/**
 * The demo day as a `Date` at noon UTC: any formatter in a time zone within ±11 h of UTC prints the same calendar
 * day, where midnight UTC would print the day before in the Americas.
 */
export function demoDayOf(dueOn: string): Date {
  return new Date(`${dueOn}T12:00:00Z`);
}

/** Whole days from the reader's local today to the demo day; negative once it has passed. */
export function daysUntilDemo(dueOn: string, now: Date): number {
  const [year, month, day] = dueOn.split('-').map(Number);
  const due = Date.UTC(year ?? 0, (month ?? 1) - 1, day ?? 1);
  const today = Date.UTC(now.getFullYear(), now.getMonth(), now.getDate());
  return Math.round((due - today) / DAY_MS);
}
