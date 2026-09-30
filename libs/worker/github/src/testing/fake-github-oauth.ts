/**
 * Test and local-run only: a stateful stand-in for GitHub's side of the owner connection — the authorize step, the
 * token endpoint (code + PKCE, single-use rotating refresh tokens, errors in a 200's JSON `error`), `GET /user` and
 * grant revocation. The api specs use it through `fetch`; `nx run api:fake-github` serves it as a local Worker.
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
  | 'authorize-denied';

export interface FakeGitHubOAuthOptions {
  readonly clientId: string;
  readonly clientSecret: string;
  readonly accessLifetimeSeconds?: number;
  readonly refreshLifetimeSeconds?: number;
  /** Milliseconds since the epoch. */
  readonly now?: () => number;
  /** Delay of the refresh answer (concurrency tests). */
  readonly refreshDelayMs?: number;
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

const CODE_LIFETIME_MS = 10 * 60 * 1000;

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
  /** The account that approves on the authorize page. */
  user: FakeUser = { login: 'geeera', id: 1001 };
  private readonly faults = new Set<FakeFault>();
  private readonly codes = new Map<string, PendingCode>();
  private readonly accessTokens = new Map<string, IssuedToken>();
  private readonly refreshTokens = new Map<string, IssuedToken>();
  private readonly grants = new Map<number, { readonly user: FakeUser; active: boolean }>();
  private nextGrant = 1;
  private readonly now: () => number;

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

  private grantOfBearer(request: Request): { user: FakeUser } | undefined {
    const bearer = /^(?:Bearer|token) (\S+)$/.exec(request.headers.get('authorization') ?? '')?.[1] ?? '';
    const token = this.accessTokens.get(bearer);
    const grant = token === undefined ? undefined : this.grants.get(token.grant);
    return token !== undefined && token.expiresAt > this.now() && grant?.active === true ? grant : undefined;
  }

  private mint(grant: number): { accessToken: string; refreshToken: string } {
    // Assembled at run time: real token shapes for the sentinel checks, no token-shaped literal in the repository.
    const accessToken = ['ghu', random(18)].join('_');
    const refreshToken = ['ghr', random(30)].join('_');
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
