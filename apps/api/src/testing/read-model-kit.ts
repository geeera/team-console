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
    const [, , owner, name, list] = call.url.pathname.split('/');
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
    return json(404, { message: 'Not Found' });
  };
}
