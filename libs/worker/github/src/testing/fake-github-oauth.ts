/**
 * Test and local-run only: a stateful stand-in for GitHub's side of the owner connection — the authorize step, the
 * token endpoint (code + PKCE, single-use rotating refresh tokens, errors in a 200's JSON `error`), `GET /user`,
 * grant revocation, and the owner's issue comments (#10: accepted only with a live owner access token). The api specs use it through `fetch`; `nx run api:fake-github` serves it as a local Worker.
 *
 * Issue threads (#114): an issue seeded with `seedIssue` is served like a public repository's — `GET` of the issue,
 * its comments and the repository need no token — and takes labels (`POST …/labels`, `DELETE …/labels/{name}`) and
 * comments from a live owner token, so the run log can be paused, resumed and read back in one place.
 */

export interface FakeUser {
  readonly login: string;
  readonly id: number;
}

/** One-shot faults for the next matching request. */
export type FakeFault =
  | 'refresh-unavailable'
  | 'refresh-bad-refresh-token'
  | 'revoke-unavailable'
  | 'exchange-non-expiring'
  | 'user-unavailable'
  | 'authorize-denied'
  | 'comment-token-rejected'
  | 'comment-unavailable';

/** A comment the owner's token wrote (`POST /repos/{owner}/{repo}/issues/{n}/comments`). */
export interface FakeComment {
  readonly id: number;
  readonly repo: string;
  readonly issue: number;
  readonly body: string;
  readonly author: string;
}

export interface FakeGitHubOAuthOptions {
  readonly clientId: string;
  readonly clientSecret: string;
  readonly accessLifetimeSeconds?: number;
  readonly refreshLifetimeSeconds?: number;
  /** Milliseconds since the epoch. */
  readonly now?: () => number;
  /** Delay of the refresh answer (concurrency tests). */
  readonly refreshDelayMs?: number;
  /** Put after `ghu_`/`ghr_` in every minted token, e.g. `TESTSENTINEL` for the sentinel checks. */
  readonly tokenTag?: string;
}

interface PendingCode {
  readonly user: FakeUser;
  readonly challenge: string;
  readonly redirectUri: string;
  readonly expiresAt: number;
}

interface IssuedToken {
  readonly grant: number;
  readonly expiresAt: number;
  used: boolean;
}

export interface FakeCall {
  readonly method: string;
  readonly url: string;
}

/** An issue thread the fake serves (#114). */
export interface FakeIssueSeed {
  readonly repo: string;
  readonly number: number;
  readonly title: string;
  /** Who opened it; the run log trusts its author's entries. */
  readonly author: string;
  readonly labels?: readonly string[];
  /** `owner.login` / `owner.id` of `GET /repos/{repo}`. */
  readonly repoOwner?: FakeUser;
}

interface FakeThreadComment {
  readonly id: number;
  readonly body: string;
  readonly author: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/** A comment put straight into a seeded thread (a team entry written earlier, an edited one). */
export interface FakeThreadCommentSeed {
  readonly body: string;
  readonly author: string;
  /** Milliseconds since the epoch. */
  readonly createdAt: number;
  /** Defaults to `createdAt`; a later value makes the comment edited. */
  readonly updatedAt?: number;
}

interface FakeIssue {
  readonly seed: FakeIssueSeed;
  readonly labels: string[];
  readonly comments: FakeThreadComment[];
}

const CODE_LIFETIME_MS = 10 * 60 * 1000;
const COMMENTS_PATH = /^\/repos\/([^/]+)\/([^/]+)\/issues\/([0-9]+)\/comments$/;
const ISSUE_PATH = /^\/repos\/([^/]+)\/([^/]+)\/issues\/([0-9]+)$/;
const LABELS_PATH = /^\/repos\/([^/]+)\/([^/]+)\/issues\/([0-9]+)\/labels(?:\/([^/]+))?$/;
const REPO_PATH = /^\/repos\/([^/]+)\/([^/]+)$/;

/** GitHub's second-precision timestamps. */
function githubTime(ms: number): string {
  return `${new Date(ms).toISOString().slice(0, 19)}Z`;
}

function random(bytes: number): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(bytes)), (b) =>
    b.toString(16).padStart(2, '0'),
  ).join('');
}

async function challengeOf(verifier: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier)));
  let binary = '';
  for (const byte of digest) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

export class FakeGitHubOAuth {
  readonly calls: FakeCall[] = [];
  readonly comments: FakeComment[] = [];
  /** The account that approves on the authorize page. */
  user: FakeUser = { login: 'geeera', id: 1001 };
  private readonly faults = new Set<FakeFault>();
  private readonly codes = new Map<string, PendingCode>();
  private readonly accessTokens = new Map<string, IssuedToken>();
  private readonly refreshTokens = new Map<string, IssuedToken>();
  private readonly grants = new Map<number, { readonly user: FakeUser; active: boolean }>();
  private nextGrant = 1;
  private readonly now: () => number;
  private readonly issues = new Map<string, FakeIssue>();

  constructor(private readonly options: FakeGitHubOAuthOptions) {
    this.now = options.now ?? (() => Date.now());
  }

  /** `fetch` for the Worker: the real github.com / api.github.com URLs. */
  readonly fetch = async (input: string, init: RequestInit): Promise<Response> =>
    this.handle(new Request(input, init));

  fail(fault: FakeFault): void {
    this.faults.add(fault);
  }

  refreshCalls(): number {
    return this.calls.filter(
      (call) => call.method === 'POST' && call.url.endsWith('/login/oauth/access_token'),
    ).length;
  }

  activeGrants(): number {
    return [...this.grants.values()].filter((grant) => grant.active).length;
  }

  /** The owner pressing "Authorize" on GitHub's page: validates the request and returns the `code`. */
  authorize(authorizeUrl: string, user: FakeUser = this.user): string {
    const url = new URL(authorizeUrl);
    const params = url.searchParams;
    if (
      url.origin !== 'https://github.com' ||
      url.pathname !== '/login/oauth/authorize' ||
      params.get('client_id') !== this.options.clientId ||
      params.get('code_challenge_method') !== 'S256' ||
      (params.get('code_challenge') ?? '') === '' ||
      (params.get('redirect_uri') ?? '') === ''
    ) {
      throw new Error('the fake GitHub refused the authorize request');
    }
    const code = random(10);
    this.codes.set(code, {
      user,
      challenge: params.get('code_challenge') ?? '',
      redirectUri: params.get('redirect_uri') ?? '',
      expiresAt: this.now() + CODE_LIFETIME_MS,
    });
    return code;
  }

  /** Serves an issue thread (#114); seeding it again resets its labels and comments. */
  seedIssue(seed: FakeIssueSeed): void {
    this.issues.set(`${seed.repo.toLowerCase()}#${seed.number}`, {
      seed,
      labels: [...(seed.labels ?? [])],
      comments: [],
    });
  }

  /** Appends a comment to a seeded thread, as if written at `createdAt`. */
  addComment(repo: string, number: number, seed: FakeThreadCommentSeed): number {
    const issue = this.issues.get(`${repo.toLowerCase()}#${number}`);
    if (issue === undefined) {
      throw new Error(`the fake GitHub serves no issue ${repo}#${number}`);
    }
    const id = 6_000_000 + issue.comments.length + 1;
    issue.comments.push({
      id,
      body: seed.body,
      author: seed.author,
      createdAt: githubTime(seed.createdAt),
      updatedAt: githubTime(seed.updatedAt ?? seed.createdAt),
    });
    return id;
  }

  /** The labels of a seeded issue, for assertions. */
  labelsOf(repo: string, number: number): readonly string[] {
    return this.issues.get(`${repo.toLowerCase()}#${number}`)?.labels ?? [];
  }

  /** Issues a pair without the web flow (to seed a connection in tests). */
  issuePair(user: FakeUser = this.user): { accessToken: string; refreshToken: string } {
    const grant = this.nextGrant++;
    this.grants.set(grant, { user, active: true });
    return this.mint(grant);
  }

  async handle(request: Request): Promise<Response> {
    const url = new URL(request.url);
    this.calls.push({ method: request.method, url: `${url.origin}${url.pathname}` });
    if (
      url.origin === 'https://github.com' &&
      request.method === 'GET' &&
      url.pathname === '/login/oauth/authorize'
    ) {
      return this.authorizePage(url);
    }
    if (
      url.origin === 'https://github.com' &&
      request.method === 'POST' &&
      url.pathname === '/login/oauth/access_token'
    ) {
      return this.tokenEndpoint(new URLSearchParams(await request.text()));
    }
    if (url.origin === 'https://api.github.com' && request.method === 'GET' && url.pathname === '/user') {
      return this.userEndpoint(request);
    }
    const comments = COMMENTS_PATH.exec(url.pathname);
    if (url.origin === 'https://api.github.com' && request.method === 'POST' && comments !== null) {
      return this.commentEndpoint(request, `${comments[1] ?? ''}/${comments[2] ?? ''}`, Number(comments[3]));
    }
    if (url.origin === 'https://api.github.com') {
      const thread = await this.threadEndpoint(request, url);
      if (thread !== null) {
        return thread;
      }
    }
    const revoke = /^\/applications\/([^/]+)\/grant$/.exec(url.pathname);
    if (url.origin === 'https://api.github.com' && request.method === 'DELETE' && revoke !== null) {
      return this.revokeEndpoint(request, decodeURIComponent(revoke[1] ?? ''));
    }
    return json(404, { message: 'Not Found' });
  }

  private takeFault(fault: FakeFault): boolean {
    return this.faults.delete(fault);
  }

  /** The browser at GitHub: approves as `user` and redirects back, like the owner pressing Authorize. */
  private authorizePage(url: URL): Response {
    const redirect = new URL(url.searchParams.get('redirect_uri') ?? 'about:blank');
    redirect.searchParams.set('state', url.searchParams.get('state') ?? '');
    if (this.takeFault('authorize-denied')) {
      redirect.searchParams.set('error', 'access_denied');
    } else {
      redirect.searchParams.set('code', this.authorize(url.href));
    }
    return new Response(null, { status: 302, headers: { Location: redirect.href } });
  }

  private async tokenEndpoint(form: URLSearchParams): Promise<Response> {
    if (
      form.get('client_id') !== this.options.clientId ||
      form.get('client_secret') !== this.options.clientSecret
    ) {
      return json(200, { error: 'incorrect_client_credentials' });
    }
    if (form.get('grant_type') === 'refresh_token') {
      if (this.options.refreshDelayMs !== undefined) {
        await new Promise((resolve) => setTimeout(resolve, this.options.refreshDelayMs));
      }
      if (this.takeFault('refresh-unavailable')) {
        return json(502, { message: 'unavailable' });
      }
      const refresh = this.refreshTokens.get(form.get('refresh_token') ?? '');
      if (
        this.takeFault('refresh-bad-refresh-token') ||
        refresh === undefined ||
        refresh.used ||
        refresh.expiresAt <= this.now() ||
        this.grants.get(refresh.grant)?.active !== true
      ) {
        return json(200, {
          error: 'bad_refresh_token',
          error_description: 'The refresh token passed is incorrect or expired.',
        });
      }
      refresh.used = true;
      // GitHub: a refresh ends the old access token too.
      for (const [token, issued] of this.accessTokens) {
        if (issued.grant === refresh.grant) {
          this.accessTokens.delete(token);
        }
      }
      return json(200, this.pairBody(this.mint(refresh.grant)));
    }
    const pending = this.codes.get(form.get('code') ?? '');
    this.codes.delete(form.get('code') ?? '');
    if (
      pending === undefined ||
      pending.expiresAt <= this.now() ||
      pending.redirectUri !== form.get('redirect_uri') ||
      pending.challenge !== (await challengeOf(form.get('code_verifier') ?? ''))
    ) {
      return json(200, { error: 'bad_verification_code' });
    }
    const grant = this.nextGrant++;
    this.grants.set(grant, { user: pending.user, active: true });
    const pair = this.mint(grant);
    if (this.takeFault('exchange-non-expiring')) {
      return json(200, { access_token: pair.accessToken, token_type: 'bearer', scope: '' });
    }
    return json(200, this.pairBody(pair));
  }

  private issueOf(
    owner: string | undefined,
    name: string | undefined,
    number: string | undefined,
  ): FakeIssue | undefined {
    return this.issues.get(`${`${owner ?? ''}/${name ?? ''}`.toLowerCase()}#${Number(number)}`);
  }

  /** Reads and label writes of seeded issue threads; `null` when the path is not one of them. */
  private async threadEndpoint(request: Request, url: URL): Promise<Response | null> {
    const method = request.method;
    const issuePath = ISSUE_PATH.exec(url.pathname);
    if (method === 'GET' && issuePath !== null) {
      const issue = this.issueOf(issuePath[1], issuePath[2], issuePath[3]);
      return issue === undefined ? json(404, { message: 'Not Found' }) : json(200, this.issueJson(issue));
    }
    const commentsPath = COMMENTS_PATH.exec(url.pathname);
    if (method === 'GET' && commentsPath !== null) {
      const issue = this.issueOf(commentsPath[1], commentsPath[2], commentsPath[3]);
      if (issue === undefined) {
        return json(404, { message: 'Not Found' });
      }
      const perPage = Math.min(Math.max(Number(url.searchParams.get('per_page') ?? 30) || 30, 1), 100);
      const page = Math.max(Number(url.searchParams.get('page') ?? 1) || 1, 1);
      const items = issue.comments
        .slice((page - 1) * perPage, page * perPage)
        .map((c) => this.commentJson(issue, c));
      const headers: Record<string, string> = {};
      if (page * perPage < issue.comments.length) {
        const next = new URL(url.href);
        next.searchParams.set('page', String(page + 1));
        next.searchParams.set('per_page', String(perPage));
        headers['Link'] = `<${next.href}>; rel="next"`;
      }
      return new Response(JSON.stringify(items), {
        status: 200,
        headers: { 'Content-Type': 'application/json', ...headers },
      });
    }
    const labelsPath = LABELS_PATH.exec(url.pathname);
    if ((method === 'POST' || method === 'DELETE') && labelsPath !== null) {
      const issue = this.issueOf(labelsPath[1], labelsPath[2], labelsPath[3]);
      if (issue === undefined) {
        return json(404, { message: 'Not Found' });
      }
      if (this.grantOfBearer(request) === undefined) {
        return json(401, { message: 'Bad credentials' });
      }
      if (method === 'POST') {
        const body = (await request.json()) as { labels?: unknown };
        const names = Array.isArray(body.labels)
          ? body.labels.filter((x): x is string => typeof x === 'string')
          : [];
        for (const name of names) {
          if (!issue.labels.includes(name)) {
            issue.labels.push(name);
          }
        }
        return json(
          200,
          issue.labels.map((name) => ({ name })),
        );
      }
      const name = decodeURIComponent(labelsPath[4] ?? '');
      const at = issue.labels.indexOf(name);
      if (at < 0) {
        return json(404, { message: 'Label does not exist' });
      }
      issue.labels.splice(at, 1);
      return json(
        200,
        issue.labels.map((label) => ({ name: label })),
      );
    }
    const repoPath = REPO_PATH.exec(url.pathname);
    if (method === 'GET' && repoPath !== null) {
      const fullName = `${repoPath[1] ?? ''}/${repoPath[2] ?? ''}`;
      const seeded = [...this.issues.values()].find(
        (issue) =>
          issue.seed.repo.toLowerCase() === fullName.toLowerCase() && issue.seed.repoOwner !== undefined,
      );
      return seeded?.seed.repoOwner === undefined
        ? json(404, { message: 'Not Found' })
        : json(200, {
            full_name: seeded.seed.repo,
            private: false,
            default_branch: 'dev',
            owner: { login: seeded.seed.repoOwner.login, id: seeded.seed.repoOwner.id, type: 'User' },
          });
    }
    return null;
  }

  private issueJson(issue: FakeIssue): Record<string, unknown> {
    const { repo, number, title, author } = issue.seed;
    return {
      number,
      title,
      state: 'open',
      body: '',
      labels: issue.labels.map((name) => ({ name })),
      user: { login: author, type: 'User' },
      author_association: 'OWNER',
      html_url: `https://github.com/${repo}/issues/${number}`,
      comments: issue.comments.length,
    };
  }

  private commentJson(issue: FakeIssue, comment: FakeThreadComment): Record<string, unknown> {
    return {
      id: comment.id,
      body: comment.body,
      user: { login: comment.author, type: 'User' },
      author_association: 'OWNER',
      created_at: comment.createdAt,
      updated_at: comment.updatedAt,
      html_url: `https://github.com/${issue.seed.repo}/issues/${issue.seed.number}#issuecomment-${comment.id}`,
    };
  }

  private userEndpoint(request: Request): Response {
    if (this.takeFault('user-unavailable')) {
      return json(503, { message: 'unavailable' });
    }
    const grant = this.grantOfBearer(request);
    return grant === undefined
      ? json(401, { message: 'Bad credentials' })
      : json(200, { ...grant.user, type: 'User' });
  }

  private async revokeEndpoint(request: Request, clientId: string): Promise<Response> {
    const expected = `Basic ${btoa(`${this.options.clientId}:${this.options.clientSecret}`)}`;
    if (clientId !== this.options.clientId || request.headers.get('authorization') !== expected) {
      return json(401, { message: 'Bad credentials' });
    }
    if (this.takeFault('revoke-unavailable')) {
      return json(502, { message: 'unavailable' });
    }
    const body = (await request.json()) as { access_token?: unknown };
    const token = this.accessTokens.get(typeof body.access_token === 'string' ? body.access_token : '');
    const grant = token === undefined ? undefined : this.grants.get(token.grant);
    if (token === undefined || grant === undefined || !grant.active) {
      return json(404, { message: 'Not Found' });
    }
    grant.active = false;
    return new Response(null, { status: 204 });
  }

  private async commentEndpoint(request: Request, repo: string, issue: number): Promise<Response> {
    const grant = this.grantOfBearer(request);
    if (grant === undefined || this.takeFault('comment-token-rejected')) {
      return json(401, { message: 'Bad credentials' });
    }
    if (this.takeFault('comment-unavailable')) {
      return json(502, { message: 'unavailable' });
    }
    const body = (await request.json()) as { body?: unknown };
    if (typeof body.body !== 'string' || body.body === '') {
      return json(422, { message: 'Validation Failed' });
    }
    const comment: FakeComment = {
      id: 5_000_000 + this.comments.length + 1,
      repo,
      issue,
      body: body.body,
      author: grant.user.login,
    };
    this.comments.push(comment);
    const thread = this.issues.get(`${repo.toLowerCase()}#${issue}`);
    const at = githubTime(this.now());
    thread?.comments.push({
      id: comment.id,
      body: comment.body,
      author: comment.author,
      createdAt: at,
      updatedAt: at,
    });
    return json(201, {
      id: comment.id,
      html_url: `https://github.com/${repo}/issues/${issue}#issuecomment-${comment.id}`,
      body: comment.body,
      user: { login: grant.user.login, id: grant.user.id },
    });
  }

  private grantOfBearer(request: Request): { user: FakeUser } | undefined {
    const bearer = /^(?:Bearer|token) (\S+)$/.exec(request.headers.get('authorization') ?? '')?.[1] ?? '';
    const token = this.accessTokens.get(bearer);
    const grant = token === undefined ? undefined : this.grants.get(token.grant);
    return token !== undefined && token.expiresAt > this.now() && grant?.active === true ? grant : undefined;
  }

  private mint(grant: number): { accessToken: string; refreshToken: string } {
    // Assembled at run time: real token shapes for the sentinel checks, no token-shaped literal in the repository.
    const tag = this.options.tokenTag ?? '';
    const accessToken = ['ghu', `${tag}${random(18)}`].join('_');
    const refreshToken = ['ghr', `${tag}${random(30)}`].join('_');
    const now = this.now();
    this.accessTokens.set(accessToken, { grant, expiresAt: now + this.accessLifetime() * 1000, used: false });
    this.refreshTokens.set(refreshToken, {
      grant,
      expiresAt: now + this.refreshLifetime() * 1000,
      used: false,
    });
    return { accessToken, refreshToken };
  }

  private pairBody(pair: { accessToken: string; refreshToken: string }): Record<string, unknown> {
    return {
      access_token: pair.accessToken,
      expires_in: this.accessLifetime(),
      refresh_token: pair.refreshToken,
      refresh_token_expires_in: this.refreshLifetime(),
      token_type: 'bearer',
      scope: '',
    };
  }

  private accessLifetime(): number {
    return this.options.accessLifetimeSeconds ?? 8 * 60 * 60;
  }

  private refreshLifetime(): number {
    return this.options.refreshLifetimeSeconds ?? 184 * 24 * 60 * 60;
  }
}
