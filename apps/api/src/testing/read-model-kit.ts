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
