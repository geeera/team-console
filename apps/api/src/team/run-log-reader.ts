import type { TeamState } from '@shared/contracts';
import { githubPath, type RepoName } from '@worker/github';
import { TRUSTED_BOT_LOGINS } from '@worker/read-models';
import {
  PAUSED_LABEL,
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

export interface RunLogIssue {
  readonly number: number;
  readonly htmlUrl: string;
  readonly author: string;
  readonly labels: readonly string[];
}

export interface RunLogView {
  /** `null` while the team has not opened its run log. */
  readonly issue: RunLogIssue | null;
  readonly runs: readonly Run[];
  readonly ownerPause: OwnerPause | null;
  readonly paused: boolean;
  readonly state: TeamState;
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
  };
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
async function findRunLogIssue(installation: GitHubConnection, repo: RepoName): Promise<RunLogIssue | null> {
  const client = repositoryClient(installation, repo);
  const pinned = runLogIssueOf((await readProjectYml(client, repo)) ?? '');
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

export async function readRunLog(installation: GitHubConnection, repo: RepoName): Promise<RunLogView> {
  const issue = await findRunLogIssue(installation, repo);
  if (issue === null) {
    return { issue: null, runs: [], ownerPause: null, paused: false, state: 'running' };
  }
  const raw = await repositoryClient(installation, repo).paginate(
    githubPath`/repos/${repo}/issues/${issue.number}/comments?per_page=${100}`,
    isGitHubComment,
    { maxPages: MAX_COMMENT_PAGES },
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
  return { issue, runs, ownerPause, paused, state };
}
