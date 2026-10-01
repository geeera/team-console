import type {
  SprintDto,
  SprintIssueDto,
  SprintMilestoneDto,
  SprintPullRequestDto,
  SprintTier,
} from '@shared/contracts';
import { isGitHubPageUrl } from '@shared/contracts';

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
}

export interface SprintPullRequest {
  readonly number: number;
  readonly title: string;
  readonly url: string | null;
  readonly draft: boolean;
  readonly authorTrusted: boolean;
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
}

/** The lane of an issue without a `status:*` label — the key `backlog list` / the read model count it under. */
export const NO_STATUS = 'none';

/** The plugin's workflow order (reference/workflow.md → Status); a lane for any other label follows these. */
export const STATUS_ORDER: readonly string[] = ['proposed', 'approved', 'in-progress', 'qa', 'blocked', 'done'];

/** Lanes shown even when empty, so "nothing in QA" reads as a fact rather than a missing lane. */
export const CORE_STATUSES: readonly string[] = ['approved', 'in-progress', 'qa', 'done'];

const TIERS: ReadonlySet<string> = new Set<SprintTier>(['light', 'standard', 'heavy']);
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
    typeof value['authorTrusted'] === 'boolean'
  );
}

function isPullRequest(value: unknown): value is SprintPullRequestDto {
  return (
    isRecord(value) &&
    isIssueNumber(value['number']) &&
    typeof value['title'] === 'string' &&
    isNullableString(value['url']) &&
    typeof value['draft'] === 'boolean' &&
    typeof value['authorTrusted'] === 'boolean'
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
    value['openPullRequests'].every(isPullRequest)
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
    })),
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
