import { githubUnexpectedError, mapGitHubResponse, ownerNotConnectedError } from './errors';
import { githubPathOf, type GitHubPath } from './github-path';
import type { TokenSource } from './token-source';
import { discardBody, githubRequest, onGitHubApi, readGitHubJson, type FetchLike } from './transport';

/** Narrows GitHub's JSON to what a read model uses; GitHub's raw types never leave the Worker. */
export type JsonGuard<T> = (value: unknown) => value is T;

export interface PaginateOptions {
  /** Upper bound on requests (subrequest budget); the default fits a project's open issues. */
  readonly maxPages?: number;
}

const DEFAULT_MAX_PAGES = 5;

function nextPageOf(link: string | null): URL | null {
  if (link === null) {
    return null;
  }
  for (const part of link.split(',')) {
    const match = /^\s*<([^>]+)>\s*;\s*rel="next"\s*$/.exec(part);
    if (match?.[1] !== undefined) {
      // A next page off api.github.com is not followed: the token would go with it.
      return onGitHubApi(match[1]);
    }
  }
  return null;
}

/**
 * Typed reads from api.github.com (ADR 0001 decision 6, ADR 0003 decision 6). Constructed per request with
 * a `TokenSource`, never a token string. There is no generic "call any path" route on top of it: every
 * caller builds its path with `githubPath` from a validated `RepoName` (#9 threat row 2).
 */
export class GitHubClient {
  constructor(
    private readonly fetcher: FetchLike,
    private readonly tokens: TokenSource,
  ) {}

  /** GET one resource; non-2xx → `GitHubError`, a body the guard rejects → 502 `github-unexpected`. */
  async getJson<T>(path: GitHubPath, guard: JsonGuard<T>): Promise<T> {
    const response = await this.get(path);
    return this.parse(response, guard);
  }

  /** GET a list, following `Link: rel="next"` up to `maxPages`; each item must pass the guard. */
  async paginate<T>(path: GitHubPath, itemGuard: JsonGuard<T>, options: PaginateOptions = {}): Promise<T[]> {
    const maxPages = options.maxPages ?? DEFAULT_MAX_PAGES;
    const items: T[] = [];
    let next: GitHubPath | null = path;
    for (let page = 0; next !== null && page < maxPages; page += 1) {
      const response = await this.get(next);
      const nextUrl = nextPageOf(response.headers.get('link'));
      const body = await this.parse(response, (value): value is unknown[] => Array.isArray(value));
      for (const item of body) {
        if (!itemGuard(item)) {
          throw githubUnexpectedError('GitHub returned an item of an unexpected shape', response.status);
        }
        items.push(item);
      }
      next = nextUrl === null ? null : githubPathOf(nextUrl);
    }
    return items;
  }

  /**
   * POST one resource — an owner write (#10) — and narrow GitHub's answer with the guard. Never retried after a
   * timeout, a network failure or a 5xx: GitHub may have written it, and a retry could post twice. A 401 is the one
   * retry: GitHub refused the token before writing anything, so the source refreshes once (#59) and the request is
   * sent again; a second 401 on the owner's token is 403 `github-owner-not-connected`, never a fallback token.
   */
  async postJson<T>(path: GitHubPath, body: unknown, guard: JsonGuard<T>): Promise<T> {
    let token = await this.tokens.getToken();
    let response = await githubRequest(this.fetcher, { method: 'POST', path, bearer: token, body });
    if (response.status === 401) {
      await discardBody(response);
      this.tokens.invalidate(token);
      token = await this.tokens.getToken();
      response = await githubRequest(this.fetcher, { method: 'POST', path, bearer: token, body });
      if (response.status === 401 && this.tokens.kind === 'owner') {
        await discardBody(response);
        throw ownerNotConnectedError();
      }
    }
    if (!response.ok) {
      await discardBody(response);
      throw mapGitHubResponse(response);
    }
    return this.parse(response, guard);
  }

  private async get(path: GitHubPath): Promise<Response> {
    let token = await this.tokens.getToken();
    let response = await githubRequest(this.fetcher, { method: 'GET', path, bearer: token });
    if (response.status === 401) {
      // A cached token revoked or expired early (key rotation, reinstall): evict it and retry once.
      await discardBody(response);
      this.tokens.invalidate(token);
      token = await this.tokens.getToken();
      response = await githubRequest(this.fetcher, { method: 'GET', path, bearer: token });
    }
    if (!response.ok) {
      await discardBody(response);
      throw mapGitHubResponse(response);
    }
    return response;
  }

  private async parse<T>(response: Response, guard: JsonGuard<T>): Promise<T> {
    const body = await readGitHubJson(response);
    if (!guard(body)) {
      throw githubUnexpectedError('GitHub returned a body of an unexpected shape', response.status);
    }
    return body;
  }
}
