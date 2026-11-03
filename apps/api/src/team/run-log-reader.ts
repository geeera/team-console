import type { TeamState } from '@shared/contracts';
import { commandLines } from '@shared/owner-grammar';
import { githubPath, type RepoName } from '@worker/github';
import { TRUSTED_BOT_LOGINS } from '@worker/read-models';
import {
  OWNER_RESUME,
  PAUSED_LABEL,
  PAUSE_MARKER,
  RUN_LOG_LABEL,
  activeOwnerPause,
  parseRuns,
  partitionTeamComments,
  runLogIssueOf,
  type OwnerPause,
  type Run,
  type RunLogComment,
} from '@worker/run-log';
import type { GitHubConnection } from '../github';
import { readProjectYml, repositoryClient } from '../projects/repository-checks';

/**
 * The run log as the team reads it (#114 §4–5), always fresh — no read cache: a stale label could fire a run into a
 * paused team or pause one that is paused already. Subrequests: project.yml, the issue (or the labelled list) and
 * up to `MAX_COMMENT_PAGES` pages of comments, plus the installation token on a cold isolate.
 */

/** 1000 comments: about five months of runs at the plugin's schedule. */
const MAX_COMMENT_PAGES = 10;
const COMMENTS_PER_PAGE = 100;

export interface RunLogIssue {
  readonly number: number;
  readonly htmlUrl: string;
  readonly author: string;
  readonly labels: readonly string[];
  /** GitHub's comment count on the issue; 0 when it sent none. */
  readonly comments: number;
}

export interface RunLogView {
  /** `null` while the team has not opened its run log. */
  readonly issue: RunLogIssue | null;
  readonly runs: readonly Run[];
  readonly ownerPause: OwnerPause | null;
  readonly paused: boolean;
  readonly state: TeamState;
  /**
   * `runlog start`'s `paused_since`: the latest team pause or owner-resume marker in the log (ISO 8601), `''` without
   * one. Failures before it no longer count towards a streak.
   */
  readonly pausedSince: string;
  /** The latest `/resume` command in a trusted comment of the repository owner (ISO 8601), `''` without one. */
  readonly ownerResumeAt: string;
}

export interface ReadRunLogOptions {
  /**
   * Read only the latest pages of comments (the overview, #27), found from the issue's comment count. Enough for the
   * failure streak and an active pause, since a paused team writes nothing; the team status reads them all.
   */
  readonly latestCommentPages?: number;
  /** project.yml's text when the caller has read it already (`null`: no such file); otherwise it is read here. */
  readonly projectYml?: string | null;
}

/** Why there is no usable run log; answered as 409 `run-log-missing` with this `reason`. */
export class RunLogUnavailableError extends Error {
  constructor(readonly reason: 'untrusted' | 'ambiguous') {
    super(`the run log is ${reason}`);
    this.name = 'RunLogUnavailableError';
  }
}

type JsonRecord = Readonly<Record<string, unknown>>;

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function loginOf(value: unknown): string {
  return isRecord(value) && typeof value['login'] === 'string' ? value['login'] : '';
}

function labelsOf(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.flatMap((label) => {
    if (typeof label === 'string') {
      return [label];
    }
    return isRecord(label) && typeof label['name'] === 'string' ? [label['name']] : [];
  });
}

function isGitHubIssue(value: unknown): value is JsonRecord {
  return (
    isRecord(value) &&
    Number.isSafeInteger(value['number']) &&
    typeof value['html_url'] === 'string' &&
    Array.isArray(value['labels'])
  );
}

function isGitHubComment(value: unknown): value is JsonRecord {
  return (
    isRecord(value) &&
    Number.isSafeInteger(value['id']) &&
    (value['body'] === null || typeof value['body'] === 'string') &&
    (value['created_at'] === null || typeof value['created_at'] === 'string')
  );
}

function issueOf(raw: JsonRecord): RunLogIssue {
  return {
    number: Number(raw['number']),
    htmlUrl: String(raw['html_url']),
    author: loginOf(raw['user']),
    labels: labelsOf(raw['labels']),
    comments: Number.isSafeInteger(raw['comments']) ? Number(raw['comments']) : 0,
  };
}

function latestAt(comments: readonly RunLogComment[], matches: (comment: RunLogComment) => boolean): string {
  return comments
    .filter(matches)
    .map((comment) => comment.createdAt ?? '')
    .reduce((latest, at) => (at > latest ? at : latest), '');
}

function commentOf(raw: JsonRecord): RunLogComment {
  const text = (key: string): string | null => (typeof raw[key] === 'string' ? (raw[key] as string) : null);
  return {
    id: Number(raw['id']),
    body: text('body') ?? '',
    createdAt: text('created_at'),
    updatedAt: text('updated_at'),
    author: loginOf(raw['user']),
  };
}

/**
 * Who may open the run log and write its entries: the repository owner (the agents' account in same-account mode,
 * and the owner the console writes as) and the team's GitHub App. `runlogissue.find` uses the same two.
 */
export function teamLoginsOf(repo: RepoName): string[] {
  return [repo.owner, ...TRUSTED_BOT_LOGINS];
}

function isTeamLogin(repo: RepoName, login: string): boolean {
  return teamLoginsOf(repo).some((team) => team.toLowerCase() === login.toLowerCase());
}

/** `runlogissue.find`: the pinned issue (refused unless the team opened it), else the one labelled issue it opened. */
async function findRunLogIssue(
  installation: GitHubConnection,
  repo: RepoName,
  projectYml: string | null | undefined,
): Promise<RunLogIssue | null> {
  const client = repositoryClient(installation, repo);
  const yml = projectYml === undefined ? await readProjectYml(client, repo) : projectYml;
  const pinned = runLogIssueOf(yml ?? '');
  if (pinned > 0) {
    const issue = issueOf(await client.getJson(githubPath`/repos/${repo}/issues/${pinned}`, isGitHubIssue));
    if (!isTeamLogin(repo, issue.author)) {
      throw new RunLogUnavailableError('untrusted');
    }
    return issue;
  }
  const listed = await client.paginate(
    githubPath`/repos/${repo}/issues?state=all&labels=${RUN_LOG_LABEL}&per_page=${100}`,
    isGitHubIssue,
    { maxPages: 1 },
  );
  const candidates = listed
    .filter((raw) => raw['pull_request'] === undefined)
    .map(issueOf)
    .filter((issue) => issue.labels.includes(RUN_LOG_LABEL) && isTeamLogin(repo, issue.author));
  if (candidates.length > 1) {
    throw new RunLogUnavailableError('ambiguous');
  }
  return candidates[0] ?? null;
}

export async function readRunLog(
  installation: GitHubConnection,
  repo: RepoName,
  options: ReadRunLogOptions = {},
): Promise<RunLogView> {
  const issue = await findRunLogIssue(installation, repo, options.projectYml);
  if (issue === null) {
    return {
      issue: null,
      runs: [],
      ownerPause: null,
      paused: false,
      state: 'running',
      pausedSince: '',
      ownerResumeAt: '',
    };
  }
  const pages = Math.min(options.latestCommentPages ?? MAX_COMMENT_PAGES, MAX_COMMENT_PAGES);
  const firstPage = Math.max(1, Math.ceil(issue.comments / COMMENTS_PER_PAGE) - pages + 1);
  const raw = await repositoryClient(installation, repo).paginate(
    firstPage === 1
      ? githubPath`/repos/${repo}/issues/${issue.number}/comments?per_page=${COMMENTS_PER_PAGE}`
      : githubPath`/repos/${repo}/issues/${issue.number}/comments?per_page=${COMMENTS_PER_PAGE}&page=${firstPage}`,
    isGitHubComment,
    { maxPages: pages },
  );
  // The log's author and the team, as `runlog.team_comments`; the owner too, since the console writes as the owner.
  const { trusted, untrusted } = partitionTeamComments(raw.map(commentOf), [
    issue.author,
    ...teamLoginsOf(repo),
  ]);
  const runs = parseRuns(trusted, untrusted);
  const ownerPause = activeOwnerPause(trusted);
  // The label is what every scheduled run checks; the record only says who paused and when.
  const paused = issue.labels.includes(PAUSED_LABEL);
  const state: TeamState = !paused ? 'running' : ownerPause !== null ? 'paused-by-owner' : 'paused-by-team';
  const pausedSince = latestAt(
    trusted,
    (comment) => comment.body.includes(PAUSE_MARKER) || comment.body.includes(OWNER_RESUME),
  );
  // `commands.parse`: the owner's own comments only, never the team's bot.
  const ownerResumeAt = latestAt(
    trusted,
    (comment) =>
      comment.author.toLowerCase() === repo.owner.toLowerCase() &&
      commandLines(comment.body).some((line) => line.command === 'resume'),
  );
  return { issue, runs, ownerPause, paused, state, pausedSince, ownerResumeAt };
}
