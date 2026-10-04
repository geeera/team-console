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

/** The tail of a list: its last page, and whether that page is the whole list. */
export interface ListTail<T> {
  readonly items: readonly T[];
  readonly isWholeList: boolean;
}

const DEFAULT_MAX_PAGES = 5;

/**
 * The target of the `rel` link, or `null` when the header names none. `url` is `null` for a target off
 * api.github.com (or unparsable), which is never followed: the token would go with it.
 */
function relLinkOf(link: string | null, rel: 'next' | 'last'): { readonly url: URL | null } | null {
  if (link === null) {
    return null;
  }
  for (const part of link.split(',')) {
    const match = /^\s*<([^>]+)>\s*;\s*rel="([a-z]+)"\s*$/.exec(part);
    if (match?.[1] !== undefined && match[2] === rel) {
      return { url: onGitHubApi(match[1]) };
    }
  }
  return null;
}

function nextPageOf(link: string | null): URL | null {
  return relLinkOf(link, 'next')?.url ?? null;
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
      items.push(...(await this.parseList(response, itemGuard)));
      next = nextUrl === null ? null : githubPathOf(nextUrl);
    }
    return items;
  }

  /**
   * GET the last page of a chronological list (oldest first, as GitHub sends issue events): the first page and,
   * when its `Link` names a `rel="last"` page, that page — at most two requests whatever the list's length. A last
   * link that cannot be followed is `github-unexpected`, never a silently older tail: a caller deciding on the
   * newest entries must not decide on stale ones.
   */
  async lastPage<T>(path: GitHubPath, itemGuard: JsonGuard<T>): Promise<ListTail<T>> {
    const first = await this.get(path);
    const last = relLinkOf(first.headers.get('link'), 'last');
    if (last === null) {
      return { items: await this.parseList(first, itemGuard), isWholeList: true };
    }
    await discardBody(first);
    if (last.url === null) {
      throw githubUnexpectedError('GitHub named a last page that cannot be followed', first.status);
    }
    const tail = await this.get(githubPathOf(last.url));
    return { items: await this.parseList(tail, itemGuard), isWholeList: false };
  }

  /**
   * POST one resource — an owner write (#10) — and narrow GitHub's answer with the guard. Never retried after a
   * timeout, a network failure or a 5xx: GitHub may have written it, and a retry could post twice. A 401 is the one
   * retry: GitHub refused the token before writing anything, so the source refreshes once (#59) and the request is
   * sent again; a second 401 on the owner's token is 403 `github-owner-not-connected`, never a fallback token.
   */
  async postJson<T>(path: GitHubPath, body: unknown, guard: JsonGuard<T>): Promise<T> {
    const response = await this.write('POST', path, body);
    return this.parse(response, guard);
  }

  /**
   * DELETE one resource (#114: a label off the run log), with `postJson`'s rules: one refresh on 401, never retried
   * after a timeout or a 5xx. A 404 is `github-not-found`; the caller decides whether "already gone" is fine.
   */
  async delete(path: GitHubPath): Promise<void> {
    await discardBody(await this.write('DELETE', path, undefined));
  }

  private async write(method: 'POST' | 'DELETE', path: GitHubPath, body: unknown): Promise<Response> {
    const request = (bearer: string) =>
      githubRequest(this.fetcher, { method, path, bearer, ...(body === undefined ? {} : { body }) });
    let token = await this.tokens.getToken();
    let response = await request(token);
    if (response.status === 401) {
      await discardBody(response);
      this.tokens.invalidate(token);
      token = await this.tokens.getToken();
      response = await request(token);
      if (response.status === 401 && this.tokens.kind === 'owner') {
        await discardBody(response);
        throw ownerNotConnectedError();
      }
    }
    if (!response.ok) {
      await discardBody(response);
      throw mapGitHubResponse(response);
    }
    return response;
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

  private async parseList<T>(response: Response, itemGuard: JsonGuard<T>): Promise<T[]> {
    const body = await this.parse(response, (value): value is unknown[] => Array.isArray(value));
    return body.map((item) => {
      if (!itemGuard(item)) {
        throw githubUnexpectedError('GitHub returned an item of an unexpected shape', response.status);
      }
      return item;
    });
  }

  private async parse<T>(response: Response, guard: JsonGuard<T>): Promise<T> {
    const body = await readGitHubJson(response);
    if (!guard(body)) {
      throw githubUnexpectedError('GitHub returned a body of an unexpected shape', response.status);
    }
    return body;
  }
}
