import { isRepoFullName } from '@shared/contracts';
import { githubUnexpectedError, mapGitHubResponse, ownerNotConnectedError } from './errors';
import { githubPath, githubPathOf, type GitHubPath } from './github-path';
import type { InstallationListTokenSource, RequestTokenSource, TokenSource } from './token-source';
import { discardBody, githubRequest, onGitHubApi, readGitHubJson, type FetchLike } from './transport';

/** Narrows GitHub's JSON to what a read model uses; GitHub's raw types never leave the Worker. */
export type JsonGuard<T> = (value: unknown) => value is T;

export interface PaginateOptions {
  /** Upper bound on requests (subrequest budget); the default fits a project's open issues. */
  readonly maxPages?: number;
}

/** A list read up to a page cap: the items, and whether the cap (not the list's end) stopped the read. */
export interface BoundedList<T> {
  readonly items: readonly T[];
  /** `false` when GitHub named another page that `maxPages` did not allow. */
  readonly complete: boolean;
}

/** The tail of a list: its last page, and whether that page is the whole list. */
export interface ListTail<T> {
  readonly items: readonly T[];
  readonly isWholeList: boolean;
}

/** One entry of `GET /installation/repositories`, as much of it as the console keeps. */
export interface InstallationRepository {
  readonly fullName: string;
  readonly private: boolean;
}

export interface InstallationRepositoriesOptions {
  /** Pages of 100; the caller sizes it to its subrequest budget. */
  readonly maxPages: number;
  /**
   * Called with every page as soon as it is read, so a caller that is stopped mid-list (a subrequest budget)
   * still holds the pages before it.
   */
  readonly onPage?: (page: readonly InstallationRepository[]) => void;
}

const DEFAULT_MAX_PAGES = 5;
const INSTALLATION_REPOSITORIES_PATH = '/installation/repositories';
const INSTALLATION_PAGE_QUERY: ReadonlySet<string> = new Set(['per_page', 'page']);

/**
 * ADR 0003 decision 6 as amended by #194: the installation-wide `metadata` token reads more than names on every
 * installed repository, so the generic reads and writes refuse it before any request is sent. Reaching this is a
 * programming error (a 500), never a GitHub problem.
 */
function assertRequestSource(tokens: TokenSource): asserts tokens is RequestTokenSource {
  if (tokens.kind !== 'installation' && tokens.kind !== 'owner') {
    throw new Error(`GitHubClient refuses a ${tokens.kind} token source here`);
  }
}

function assertListSource(tokens: TokenSource): asserts tokens is InstallationListTokenSource {
  if (tokens.kind !== 'installation-list') {
    throw new Error(`listInstallationRepositories refuses a ${tokens.kind} token source`);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isInstallationRepositoryItem(
  value: unknown,
): value is { id: number; full_name: string; private: boolean } {
  return (
    isRecord(value) &&
    Number.isSafeInteger(value['id']) &&
    isRepoFullName(value['full_name']) &&
    typeof value['private'] === 'boolean'
  );
}

function isInstallationRepositoriesPage(value: unknown): value is { repositories: unknown[] } {
  return isRecord(value) && Array.isArray(value['repositories']);
}

/**
 * The next page of the installation's repository list, or `null` at the end. Following `Link` is allowed onto
 * api.github.com and `/installation/repositories` with only its paging query: a link to any other path — say a
 * `/repos/...` read — is `github-unexpected`, so the metadata token can never be steered at another endpoint.
 */
function nextInstallationPageOf(response: Response): GitHubPath | null {
  const next = relLinkOf(response.headers.get('link'), 'next');
  if (next === null) {
    return null;
  }
  const url = next.url;
  const isSameList =
    url !== null &&
    url.pathname === INSTALLATION_REPOSITORIES_PATH &&
    [...url.searchParams.keys()].every((key) => INSTALLATION_PAGE_QUERY.has(key));
  if (!isSameList) {
    throw githubUnexpectedError('GitHub named a next page off the installation list', response.status);
  }
  return githubPathOf(url);
}

/** GET with one retry after a 401 on a cached token; non-2xx → `GitHubError`. */
async function authorizedGet(fetcher: FetchLike, tokens: TokenSource, path: GitHubPath): Promise<Response> {
  let token = await tokens.getToken();
  let response = await githubRequest(fetcher, { method: 'GET', path, bearer: token });
  if (response.status === 401) {
    // A cached token revoked or expired early (key rotation, reinstall): evict it and retry once.
    await discardBody(response);
    tokens.invalidate(token);
    token = await tokens.getToken();
    response = await githubRequest(fetcher, { method: 'GET', path, bearer: token });
  }
  if (!response.ok) {
    await discardBody(response);
    throw mapGitHubResponse(response);
  }
  return response;
}

async function parseBody<T>(response: Response, guard: JsonGuard<T>): Promise<T> {
  const body = await readGitHubJson(response);
  if (!guard(body)) {
    throw githubUnexpectedError('GitHub returned a body of an unexpected shape', response.status);
  }
  return body;
}

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
 * a `RequestTokenSource`, never a token string. There is no generic "call any path" route on top of it: every
 * caller builds its path with `githubPath` from a validated `RepoName` (#9 threat row 2). The installation-wide
 * list token never reaches these methods: only `listInstallationRepositories` takes it (ADR 0003 decision 6).
 */
export class GitHubClient {
  constructor(
    private readonly fetcher: FetchLike,
    private readonly tokens: RequestTokenSource,
  ) {}

  /**
   * `GET /installation/repositories?per_page=100`, `Link` followed up to `maxPages`, with the installation-wide
   * `metadata` token (#194) — the one request that token is ever used for. The path is fixed here; no caller can
   * hand it another one, and a per-repository or owner source is refused before any request is sent.
   */
  static async listInstallationRepositories(
    fetcher: FetchLike,
    tokens: InstallationListTokenSource,
    options: InstallationRepositoriesOptions,
  ): Promise<BoundedList<InstallationRepository>> {
    assertListSource(tokens);
    const items: InstallationRepository[] = [];
    let next: GitHubPath | null = githubPath`/installation/repositories?per_page=${100}`;
    for (let page = 0; next !== null && page < options.maxPages; page += 1) {
      const response = await authorizedGet(fetcher, tokens, next);
      const following = nextInstallationPageOf(response);
      const body = await parseBody(response, isInstallationRepositoriesPage);
      const read = body.repositories.map((item) => {
        if (!isInstallationRepositoryItem(item)) {
          throw githubUnexpectedError('GitHub returned a repository of an unexpected shape', response.status);
        }
        return { fullName: item.full_name, private: item.private };
      });
      items.push(...read);
      options.onPage?.(read);
      next = following;
    }
    return { items, complete: next === null };
  }

  /** GET one resource; non-2xx → `GitHubError`, a body the guard rejects → 502 `github-unexpected`. */
  async getJson<T>(path: GitHubPath, guard: JsonGuard<T>): Promise<T> {
    const response = await this.get(path);
    return parseBody(response, guard);
  }

  /** GET a list, following `Link: rel="next"` up to `maxPages`; each item must pass the guard. */
  async paginate<T>(path: GitHubPath, itemGuard: JsonGuard<T>, options: PaginateOptions = {}): Promise<T[]> {
    return [...(await this.paginateBounded(path, itemGuard, options)).items];
  }

  /** `paginate`, saying whether `maxPages` cut the list short (`complete: false`) instead of dropping that fact. */
  async paginateBounded<T>(
    path: GitHubPath,
    itemGuard: JsonGuard<T>,
    options: PaginateOptions = {},
  ): Promise<BoundedList<T>> {
    const maxPages = options.maxPages ?? DEFAULT_MAX_PAGES;
    const items: T[] = [];
    let next: GitHubPath | null = path;
    for (let page = 0; next !== null && page < maxPages; page += 1) {
      const response = await this.get(next);
      const nextUrl = nextPageOf(response.headers.get('link'));
      items.push(...(await this.parseList(response, itemGuard)));
      next = nextUrl === null ? null : githubPathOf(nextUrl);
    }
    return { items, complete: next === null };
  }

  /**
   * GET the last page of a chronological list (oldest first, as GitHub sends issue events): the first page and,
   * when its `Link` names a `rel="last"` page, that page — at most two requests whatever the list's length. A last
   * link that cannot be followed is `github-unexpected`, never a silently older tail: a caller deciding on the
   * newest entries must not decide on stale ones. `isSameList` must accept the last link's URL as a page of the
   * list that was asked for (GitHub may spell it differently, e.g. `/repositories/{id}/…`); anything else is
   * `github-unexpected` too, so a link can never swap in another list's tail.
   */
  async lastPage<T>(
    path: GitHubPath,
    itemGuard: JsonGuard<T>,
    isSameList: (url: URL) => boolean,
  ): Promise<ListTail<T>> {
    const first = await this.get(path);
    const last = relLinkOf(first.headers.get('link'), 'last');
    if (last === null) {
      return { items: await this.parseList(first, itemGuard), isWholeList: true };
    }
    await discardBody(first);
    if (last.url === null) {
      throw githubUnexpectedError('GitHub named a last page that cannot be followed', first.status);
    }
    if (!isSameList(last.url)) {
      throw githubUnexpectedError('GitHub named a last page of another list', first.status);
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
    return parseBody(response, guard);
  }

  /**
   * DELETE one resource (#114: a label off the run log), with `postJson`'s rules: one refresh on 401, never retried
   * after a timeout or a 5xx. A 404 is `github-not-found`; the caller decides whether "already gone" is fine.
   */
  async delete(path: GitHubPath): Promise<void> {
    await discardBody(await this.write('DELETE', path, undefined));
  }

  private async write(method: 'POST' | 'DELETE', path: GitHubPath, body: unknown): Promise<Response> {
    assertRequestSource(this.tokens);
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
    assertRequestSource(this.tokens);
    return authorizedGet(this.fetcher, this.tokens, path);
  }

  private async parseList<T>(response: Response, itemGuard: JsonGuard<T>): Promise<T[]> {
    const body = await parseBody(response, (value): value is unknown[] => Array.isArray(value));
    return body.map((item) => {
      if (!itemGuard(item)) {
        throw githubUnexpectedError('GitHub returned an item of an unexpected shape', response.status);
      }
      return item;
    });
  }
}
