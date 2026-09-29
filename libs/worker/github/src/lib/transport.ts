import { githubUnavailableError, githubUnexpectedError } from './errors';
import type { GitHubPath } from './github-path';

/** The one host any GitHub credential is ever sent to (#9 threat row 1). */
export const GITHUB_API_ORIGIN = 'https://api.github.com';

/**
 * The subset of `fetch` the client uses. Pass `(input, init) => fetch(input, init)` rather than `fetch` itself:
 * a Workers `fetch` called as a method of another object throws "Illegal invocation".
 */
export type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

export const GITHUB_JSON = 'application/vnd.github+json';

export interface GitHubRequest {
  readonly method: 'GET' | 'POST';
  readonly path: GitHubPath;
  /** An installation token, an owner token or the app JWT — sent as `Bearer`, never logged. */
  readonly bearer: string;
  readonly accept?: string;
  readonly body?: unknown;
}

const REDIRECT_STATUSES: ReadonlySet<number> = new Set([301, 302, 303, 307, 308]);
// GitHub redirects renamed repositories once; more hops than this is not GitHub.
const MAX_REDIRECTS = 3;

/** Parses a URL and returns it only when it points at api.github.com over HTTPS on the default port. */
export function onGitHubApi(url: string, base?: string): URL | null {
  try {
    const parsed = new URL(url, base);
    return parsed.origin === GITHUB_API_ORIGIN && parsed.username === '' && parsed.password === ''
      ? parsed
      : null;
  } catch {
    // An unparsable Location or Link is treated like one off api.github.com: never followed.
    return null;
  }
}

/** Releases a response body we will not read (Workers warn about unread bodies). */
export async function discardBody(response: Response): Promise<void> {
  await response.body?.cancel();
}

/** GitHub's JSON body, or 502 `github-unexpected` when it is not JSON. */
export async function readGitHubJson(response: Response): Promise<unknown> {
  try {
    return (await response.json()) as unknown;
  } catch {
    throw githubUnexpectedError('GitHub returned a body that is not JSON', response.status);
  }
}

async function send(fetcher: FetchLike, url: URL, request: GitHubRequest): Promise<Response> {
  const headers: Record<string, string> = {
    Accept: request.accept ?? GITHUB_JSON,
    Authorization: `Bearer ${request.bearer}`,
    'User-Agent': 'team-console',
    'X-GitHub-Api-Version': '2022-11-28',
  };
  const init: RequestInit = { method: request.method, headers, redirect: 'manual' };
  if (request.body !== undefined) {
    headers['Content-Type'] = 'application/json';
    init.body = JSON.stringify(request.body);
  }
  try {
    return await fetcher(url.href, init);
  } catch {
    // The thrown error is dropped on purpose: it may quote the request, and the status says enough.
    throw githubUnavailableError(null);
  }
}

/**
 * One request to api.github.com with the headers GitHub asks for and `redirect: 'manual'`: a redirect is
 * followed only for GET and only while it stays on api.github.com, so the bearer never reaches another host.
 * Returns the final response whatever its status; mapping errors is the caller's call.
 */
export async function githubRequest(fetcher: FetchLike, request: GitHubRequest): Promise<Response> {
  const first = onGitHubApi(`${GITHUB_API_ORIGIN}${request.path}`);
  if (first === null) {
    throw githubUnexpectedError('refused a GitHub URL off api.github.com');
  }
  let url: URL = first;
  for (let hop = 0; ; hop += 1) {
    const response = await send(fetcher, url, request);
    if (!REDIRECT_STATUSES.has(response.status)) {
      return response;
    }
    await discardBody(response);
    const location = response.headers.get('location');
    const next: URL | null = location === null ? null : onGitHubApi(location, url.href);
    if (next === null) {
      throw githubUnexpectedError('GitHub redirected off api.github.com', response.status);
    }
    if (request.method !== 'GET' || hop + 1 >= MAX_REDIRECTS) {
      throw githubUnexpectedError(`GitHub answered ${response.status}`, response.status);
    }
    url = next;
  }
}
