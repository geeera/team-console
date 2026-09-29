import { githubUnavailableError, githubUnexpectedError, mapGitHubResponse } from './errors';
import { githubPath } from './github-path';
import {
  GITHUB_DEADLINE_MS,
  discardBody,
  githubRequest,
  readGitHubJson,
  type FetchLike,
  type GitHubBasicCredentials,
} from './transport';

/**
 * The GitHub App's OAuth web flow for the owner's user access token (ADR 0003 decision 3): the authorize URL,
 * the code and refresh exchanges at github.com, `GET /user` and grant revocation. Tokens pass through here and
 * are never logged or put into an error; the outcome of the token endpoint is read from its JSON `error` field,
 * never from the HTTP status (GitHub answers 200 with `{"error": …}`).
 */

export const GITHUB_OAUTH_AUTHORIZE_URL = 'https://github.com/login/oauth/authorize';
export const GITHUB_OAUTH_TOKEN_URL = 'https://github.com/login/oauth/access_token';

// GitHub's client ids: `Iv1.<hex>` (older apps) or `Iv23…` (newer). Anything else is a misconfigured Worker.
const CLIENT_ID_PATTERN = /^Iv[A-Za-z0-9.]{1,64}$/;
const LOGIN_PATTERN = /^[A-Za-z0-9-]{1,39}$/;
// The token endpoint's `error` is logged, so only a code-shaped value is kept.
const ERROR_CODE_PATTERN = /^[a-z_]{1,64}$/;
const TOKEN_PATTERN = /^\S{1,512}$/;

export interface GitHubOAuthOptions {
  readonly fetch: FetchLike;
  /** Milliseconds since the epoch; a seam for expiry tests. */
  readonly now?: () => number;
}

/** A user access token and its single-use refresh token; expiries in epoch seconds. */
export interface UserTokenPair {
  readonly accessToken: string;
  readonly refreshToken: string;
  readonly accessExpiresAt: number;
  readonly refreshExpiresAt: number;
}

/**
 * What the token endpoint said. `refused`: GitHub's `error` code (e.g. `bad_verification_code`,
 * `bad_refresh_token`). `non-expiring`: a token without a refresh token or expiries — the app has "Expire user
 * authorization tokens" off; the caller revokes `accessToken` (when there is one) and stores nothing.
 */
export type TokenEndpointResult =
  | { readonly kind: 'issued'; readonly pair: UserTokenPair }
  | { readonly kind: 'refused'; readonly error: string }
  | { readonly kind: 'non-expiring'; readonly accessToken: string | null };

export interface GitHubUser {
  readonly login: string;
  readonly id: number;
}

export interface AuthorizeRequest {
  readonly redirectUri: string;
  readonly state: string;
  readonly codeChallenge: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function base64UrlOf(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** RFC 7636 S256: base64url(SHA-256(verifier)). */
export async function pkceChallengeOf(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
  return base64UrlOf(new Uint8Array(digest));
}

export function isGitHubLogin(value: unknown): value is string {
  return typeof value === 'string' && LOGIN_PATTERN.test(value);
}

function isToken(value: unknown): value is string {
  return typeof value === 'string' && TOKEN_PATTERN.test(value);
}

function isPositiveSeconds(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

export class GitHubOAuth {
  private readonly fetcher: FetchLike;
  private readonly now: () => number;

  constructor(
    private readonly credentials: GitHubBasicCredentials,
    options: GitHubOAuthOptions,
  ) {
    this.fetcher = options.fetch;
    this.now = options.now ?? (() => Date.now());
  }

  /** True when the client id looks like a GitHub App's and a secret is set; checked before any flow starts. */
  static isConfigured(credentials: { clientId?: string; clientSecret?: string }): boolean {
    return (
      CLIENT_ID_PATTERN.test(credentials.clientId?.trim() ?? '') &&
      (credentials.clientSecret?.trim() ?? '') !== ''
    );
  }

  /** Built with `URL` + `searchParams` on the fixed github.com URL: nothing a caller passes can change the host. */
  authorizeUrl(request: AuthorizeRequest): string {
    const url = new URL(GITHUB_OAUTH_AUTHORIZE_URL);
    url.searchParams.set('client_id', this.credentials.clientId);
    url.searchParams.set('redirect_uri', request.redirectUri);
    url.searchParams.set('state', request.state);
    url.searchParams.set('code_challenge', request.codeChallenge);
    url.searchParams.set('code_challenge_method', 'S256');
    return url.href;
  }

  async exchangeCode(code: string, codeVerifier: string, redirectUri: string): Promise<TokenEndpointResult> {
    return this.tokenRequest({ code, code_verifier: codeVerifier, redirect_uri: redirectUri });
  }

  async refresh(refreshToken: string): Promise<TokenEndpointResult> {
    return this.tokenRequest({ grant_type: 'refresh_token', refresh_token: refreshToken });
  }

  /** `GET /user` with the fresh token: who authorized. */
  async fetchUser(accessToken: string): Promise<GitHubUser> {
    const response = await githubRequest(this.fetcher, {
      method: 'GET',
      path: githubPath`/user`,
      bearer: accessToken,
    });
    if (!response.ok) {
      await discardBody(response);
      throw mapGitHubResponse(response, this.now());
    }
    const body = await readGitHubJson(response);
    if (
      !isRecord(body) ||
      !isGitHubLogin(body['login']) ||
      typeof body['id'] !== 'number' ||
      !Number.isSafeInteger(body['id']) ||
      body['id'] <= 0
    ) {
      throw githubUnexpectedError('GitHub returned a user of an unexpected shape', response.status);
    }
    return { login: body['login'], id: body['id'] };
  }

  /**
   * `DELETE /applications/{client_id}/grant`: ends the app's grant for that user and every token of it.
   * 204 → `revoked`; 404 → `already-gone` (the token or grant no longer exists). Anything else throws.
   */
  async revokeGrant(accessToken: string): Promise<'revoked' | 'already-gone'> {
    const response = await githubRequest(this.fetcher, {
      method: 'DELETE',
      path: githubPath`/applications/${this.credentials.clientId}/grant`,
      basic: this.credentials,
      body: { access_token: accessToken },
    });
    await discardBody(response);
    if (response.status === 204) {
      return 'revoked';
    }
    if (response.status === 404) {
      return 'already-gone';
    }
    throw mapGitHubResponse(response, this.now());
  }

  private async tokenRequest(fields: Record<string, string>): Promise<TokenEndpointResult> {
    const body = new URLSearchParams({
      client_id: this.credentials.clientId,
      client_secret: this.credentials.clientSecret,
      ...fields,
    });
    let response: Response;
    try {
      response = await this.fetcher(GITHUB_OAUTH_TOKEN_URL, {
        method: 'POST',
        headers: {
          Accept: 'application/json',
          'Content-Type': 'application/x-www-form-urlencoded',
          'User-Agent': 'team-console',
        },
        body: body.toString(),
        redirect: 'manual',
        signal: AbortSignal.timeout(GITHUB_DEADLINE_MS),
      });
    } catch {
      // Dropped on purpose: the error may quote the request body, which holds the secret and the code.
      throw githubUnavailableError(null);
    }
    if (response.status >= 300 && response.status < 400) {
      await discardBody(response);
      throw githubUnexpectedError('GitHub redirected the token request', response.status);
    }
    if (response.status >= 500) {
      await discardBody(response);
      throw githubUnavailableError(response.status);
    }
    const json = await readGitHubJson(response);
    if (!isRecord(json)) {
      throw githubUnexpectedError('GitHub returned a token response of an unexpected shape', response.status);
    }
    if (json['error'] !== undefined) {
      const error =
        typeof json['error'] === 'string' && ERROR_CODE_PATTERN.test(json['error'])
          ? json['error']
          : 'invalid';
      return { kind: 'refused', error };
    }
    if (!response.ok) {
      throw githubUnexpectedError(`GitHub answered ${response.status}`, response.status);
    }
    return this.pairOf(json, response.status);
  }

  private pairOf(json: Record<string, unknown>, status: number): TokenEndpointResult {
    const accessToken = json['access_token'];
    if (!isToken(accessToken)) {
      throw githubUnexpectedError('GitHub returned no access token', status);
    }
    const refreshToken = json['refresh_token'];
    const expiresIn = json['expires_in'];
    const refreshExpiresIn = json['refresh_token_expires_in'];
    if (!isToken(refreshToken) || !isPositiveSeconds(expiresIn) || !isPositiveSeconds(refreshExpiresIn)) {
      return { kind: 'non-expiring', accessToken };
    }
    const nowSeconds = Math.floor(this.now() / 1000);
    return {
      kind: 'issued',
      pair: {
        accessToken,
        refreshToken,
        accessExpiresAt: nowSeconds + expiresIn,
        refreshExpiresAt: nowSeconds + refreshExpiresIn,
      },
    };
  }
}
