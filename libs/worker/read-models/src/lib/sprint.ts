import type { SprintDto, SprintIssueDto, SprintTier, SprintTierRowDto } from '@shared/contracts';
import { kindOf } from '@shared/owner-grammar';
import type { IssueRecord, MilestoneRecord, PullRequestRecord } from './github-records';
import { githubUrlOrNull, isTrustedAuthor } from './untrusted-text';

/**
 * The sprint board's numbers, ported from the plugin: `calendar.pick_current_sprint`, `tiers.declared` /
 * `tiers.effective` and `metrics.sprint_summary` (cycle time and QA rates need per-issue event and review reads
 * and are left to the plugin's `sprint-metrics`).
 */

const TIERS: readonly SprintTier[] = ['light', 'standard', 'heavy'];
const WORK_KINDS: ReadonlySet<string> = new Set(['kind:feature', 'kind:bug', 'kind:chore', 'kind:finding']);

/** The plugin's calendar is Kyiv time (`ptlib.calendar.KYIV`), whatever the owner's timezone. */
export const SPRINT_TIME_ZONE = 'Europe/Kyiv';

/** `YYYY-MM-DD` in the sprint calendar's timezone. */
export function sprintToday(nowMs: number): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: SPRINT_TIME_ZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date(nowMs));
}

/** `calendar.pick_current_sprint`: the open milestone with the earliest due date that is today or later. */
export function pickCurrentSprint(
  milestones: readonly MilestoneRecord[],
  today: string,
): MilestoneRecord | null {
  let best: { day: string; milestone: MilestoneRecord } | null = null;
  for (const milestone of milestones) {
    if (milestone.state !== 'open' || milestone.dueOn === null || milestone.dueOn === '') {
      continue;
    }
    // GitHub stores due_on as midnight UTC of the chosen day (sometimes 07:00/08:00Z); the date part is the day.
    const day = milestone.dueOn.slice(0, 10);
    // `min()` keeps the first of equal days, as Python's does.
    if (day >= today && (best === null || day < best.day)) {
      best = { day, milestone };
    }
  }
  return best?.milestone ?? null;
}

/** `tiers.declared`: the architect's tier; `standard` when none (or several) is set. */
export function declaredTier(labels: readonly string[]): SprintTier {
  const found = labels
    .filter((label) => label.startsWith('tier:'))
    .map((label) => label.slice('tier:'.length))
    .filter((tier): tier is SprintTier => (TIERS as readonly string[]).includes(tier));
  return found.length === 1 && found[0] !== undefined ? found[0] : 'standard';
}

/** `tiers.effective` outside burn and hotfix runs: `tier-up` raises one step; security work never runs heavy. */
export function effectiveTier(labels: readonly string[]): SprintTier {
  let rank = TIERS.indexOf(declaredTier(labels));
  if (labels.includes('tier-up') && rank < TIERS.length - 1) {
    rank += 1;
  }
  const tier = TIERS[rank] ?? 'standard';
  return tier === 'heavy' && labels.includes('security') ? 'standard' : tier;
}

/** The `status:*` label as `backlog list` reads it (the first one). */
function statusOf(labels: readonly string[]): string | null {
  const label = labels.find((name) => name.startsWith('status:'));
  return label === undefined ? null : label.slice('status:'.length);
}

interface SprintSummary {
  readonly planned: number;
  readonly shipped: number;
  readonly carriedOver: number;
  readonly byTier: Record<string, SprintTierRowDto>;
}

/** `metrics.sprint_summary` without cycle time and QA verdicts. */
export function sprintSummary(issues: readonly IssueRecord[]): SprintSummary {
  const work = issues.filter((issue) => issue.labels.some((label) => WORK_KINDS.has(label)));
  const isShipped = (issue: IssueRecord): boolean =>
    issue.state === 'closed' && issue.labels.includes('status:done');
  const byTier: Record<string, { planned: number; shipped: number; raised: number }> = {};
  for (const issue of work) {
    const sized = issue.labels.some((label) => label.startsWith('tier:'));
    const tier = sized ? declaredTier(issue.labels) : 'unsized';
    const row = (byTier[tier] ??= { planned: 0, shipped: 0, raised: 0 });
    row.planned += 1;
    row.shipped += isShipped(issue) ? 1 : 0;
    // Raised = built one tier higher than sized; a heavy or security-capped issue cannot be.
    if (sized && issue.labels.includes('tier-up')) {
      const built = effectiveTier(issue.labels);
      const without = effectiveTier(issue.labels.filter((label) => label !== 'tier-up'));
      row.raised += built === without ? 0 : 1;
    }
  }
  return {
    planned: work.length,
    shipped: work.filter(isShipped).length,
    carriedOver: work.filter((issue) => issue.state === 'open').length,
    byTier,
  };
}

export interface SprintInput {
  readonly milestone: MilestoneRecord | null;
  /** Issues of that milestone, open and closed (pull requests may be in the list; they are dropped). */
  readonly milestoneIssues: readonly IssueRecord[];
  readonly openPullRequests: readonly PullRequestRecord[];
}

export function buildSprint(input: SprintInput): SprintDto {
  const pullRequests = input.openPullRequests.map((pull) => ({
    number: pull.number,
    title: pull.title,
    url: githubUrlOrNull(pull.htmlUrl),
    draft: pull.draft,
    authorTrusted: isTrustedAuthor(pull.authorAssociation),
  }));
  if (input.milestone === null) {
    return {
      milestone: null,
      issues: [],
      byStatus: {},
      planned: 0,
      shipped: 0,
      carriedOver: 0,
      byTier: {},
      openPullRequests: pullRequests,
    };
  }
  const issues = input.milestoneIssues
    .filter((issue) => !issue.isPullRequest)
    .sort((a, b) => a.number - b.number);
  const byStatus: Record<string, number> = {};
  for (const issue of issues) {
    const status = statusOf(issue.labels) ?? 'none';
    byStatus[status] = (byStatus[status] ?? 0) + 1;
  }
  return {
    milestone: {
      number: input.milestone.number,
      title: input.milestone.title,
      dueOn: (input.milestone.dueOn ?? '').slice(0, 10),
      url: githubUrlOrNull(input.milestone.htmlUrl),
    },
    issues: issues.map((issue): SprintIssueDto => ({
      number: issue.number,
      title: issue.title,
      url: githubUrlOrNull(issue.htmlUrl),
      state: issue.state,
      status: statusOf(issue.labels),
      tier: declaredTier(issue.labels),
      kind: kindOf(issue.labels),
      authorTrusted: isTrustedAuthor(issue.authorAssociation),
    })),
    byStatus,
    ...sprintSummary(issues),
    openPullRequests: pullRequests,
  };
}
