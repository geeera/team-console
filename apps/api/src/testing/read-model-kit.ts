import { json, type GitHubCall, type ReadHandler } from './github-kit';

/** Test-only: api.github.com answers for the read-model routes (#35), per repository. */

export interface RepoState {
  readonly issues?: readonly Record<string, unknown>[];
  readonly milestones?: readonly Record<string, unknown>[];
  readonly pulls?: readonly Record<string, unknown>[];
  /** project.yml text; `null` = no such file. */
  readonly projectYml?: string | null;
  /** Replaces the contents answer (e.g. a file over GitHub's 1 MB limit). */
  readonly contents?: () => Response;
  /** Check runs per head sha (#131); a sha not listed has none. */
  readonly checkRuns?: Readonly<Record<string, readonly Record<string, unknown>[]>>;
  /** Replaces the check-runs answer for every sha (e.g. 403 without the Checks permission). */
  readonly checkRunsReply?: () => Response;
}

/** A completed or running check run as GitHub lists it. */
export function checkRun(status: string, conclusion: string | null = null): Record<string, unknown> {
  return { name: 'lint-test-build', status, conclusion, app: { slug: 'github-actions' } };
}

/** An open pull request as GitHub lists it, with its head commit. */
export function pull(
  number: number,
  headSha: string,
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    number,
    title: `PR ${number}`,
    html_url: `https://github.com/geeera/team-console/pull/${number}`,
    draft: false,
    author_association: 'OWNER',
    user: { login: 'geeera', type: 'User' },
    head: { sha: headSha },
    ...extra,
  };
}

export function issue(
  number: number,
  labels: readonly string[],
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    number,
    title: `Issue ${number}`,
    body: '',
    html_url: `https://github.com/geeera/team-console/issues/${number}`,
    state: 'open',
    labels: labels.map((name) => ({ name })),
    author_association: 'OWNER',
    milestone: null,
    ...extra,
  };
}

export const TEAM_YML = "name: x\nteam:\n  reviewer_logins: ['team-console-review[bot]']\n";

function contentsOf(text: string): Response {
  const bytes = new TextEncoder().encode(text);
  let binary = '';
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return json(200, { type: 'file', encoding: 'base64', size: bytes.byteLength, content: btoa(binary) });
}

/** Routes list and contents reads to the state of the repository in the path. */
export function readModelGitHub(repos: Readonly<Record<string, RepoState>>): ReadHandler {
  return (call: GitHubCall) => {
    const [, , owner, name, list, sha, leaf] = call.url.pathname.split('/');
    const state = repos[`${owner}/${name}`];
    if (state === undefined) {
      return json(404, { message: 'Not Found' });
    }
    const query = call.url.searchParams;
    if (list === 'contents') {
      if (state.contents !== undefined) {
        return state.contents();
      }
      const yml = state.projectYml === undefined ? TEAM_YML : state.projectYml;
      return yml === null ? json(404, { message: 'Not Found' }) : contentsOf(yml);
    }
    if (list === 'issues') {
      const wantedState = query.get('state') ?? 'open';
      const milestone = query.get('milestone');
      return json(
        200,
        (state.issues ?? []).filter(
          (item) =>
            (wantedState === 'all' || item['state'] === wantedState) &&
            (milestone === null ||
              String((item['milestone'] as { number?: number } | null)?.number) === milestone),
        ),
      );
    }
    if (list === 'milestones') {
      return json(200, state.milestones ?? []);
    }
    if (list === 'pulls') {
      return json(200, state.pulls ?? []);
    }
    if (list === 'commits' && leaf === 'check-runs') {
      if (state.checkRunsReply !== undefined) {
        return state.checkRunsReply();
      }
      const runs = state.checkRuns?.[sha ?? ''] ?? [];
      return json(200, { total_count: runs.length, check_runs: runs });
    }
    return json(404, { message: 'Not Found' });
  };
}

/** The run log of `runLogGitHub`: issue #22, opened by the repository owner `geeera`. */
export const RUN_LOG_ISSUE = 22;
const RUN_LOG_OWNER = 'geeera';
const MINUTE_MS = 60_000;

export interface RunLogCommentSeed {
  readonly body: string;
  readonly minutesAgo: number;
  /** Defaults to the repository owner. */
  readonly author?: string;
  /** When the comment was edited; unset for an unedited one. */
  readonly editedMinutesAgo?: number;
}

export interface RunLogRepoState extends RepoState {
  /** The run log's comments; without them the repository has no run log. */
  readonly log?: readonly RunLogCommentSeed[];
  readonly logLabels?: readonly string[];
  /** GitHub's comment count on the log when it differs from the comments served. */
  readonly logCommentCount?: number;
}

/** A `runlog` entry: the marker the plugin writes for a run's start or end. */
export function runEntry(
  id: string,
  state: string,
  minutesAgo: number,
  extra: Partial<RunLogCommentSeed> & { readonly slot?: string } = {},
): RunLogCommentSeed {
  const { slot = 'slot-dev', ...rest } = extra;
  return {
    body: `<!-- pt-run id=${id} slot=${slot} state=${state} -->\n**${slot}** ${state}`,
    minutesAgo,
    ...rest,
  };
}

export function runLogIssueOf(repo: string, state: RunLogRepoState): Record<string, unknown> {
  return issue(RUN_LOG_ISSUE, [...(state.logLabels ?? ['team:run-log'])], {
    user: { login: RUN_LOG_OWNER },
    html_url: `https://github.com/${repo}/issues/${RUN_LOG_ISSUE}`,
    comments: state.logCommentCount ?? state.log?.length ?? 0,
  });
}

/** `readModelGitHub` plus each repository's run log (#27, #132): the labelled issue and its comments, as of `nowMs`. */
export function runLogGitHub(repos: Readonly<Record<string, RunLogRepoState>>, nowMs: number): ReadHandler {
  const withLogs: Record<string, RepoState> = {};
  for (const [name, state] of Object.entries(repos)) {
    withLogs[name] =
      state.log === undefined
        ? state
        : { ...state, issues: [...(state.issues ?? []), runLogIssueOf(name, state)] };
  }
  const reads = readModelGitHub(withLogs);
  const timeOf = (minutesAgo: number): string => new Date(nowMs - minutesAgo * MINUTE_MS).toISOString();
  return (call: GitHubCall) => {
    const match = /^\/repos\/([^/]+\/[^/]+)\/issues\/(\d+)\/comments$/.exec(call.url.pathname);
    if (match !== null) {
      const state = repos[match[1] ?? ''];
      if (state?.log === undefined || Number(match[2]) !== RUN_LOG_ISSUE) {
        return json(404, { message: 'Not Found' });
      }
      return json(
        200,
        state.log.map((comment, index) => ({
          id: 1000 + index,
          body: comment.body,
          created_at: timeOf(comment.minutesAgo),
          updated_at: timeOf(comment.editedMinutesAgo ?? comment.minutesAgo),
          user: { login: comment.author ?? RUN_LOG_OWNER },
        })),
      );
    }
    return reads(call);
  };
}
