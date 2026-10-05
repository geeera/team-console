import {
  appNotInstalledError,
  githubAuthError,
  githubUnexpectedError,
  type GitHubError,
  mapGitHubResponse,
} from './errors';
import { githubPath } from './github-path';
import type { RepoName } from './repo-name';
import type { InstallationTokenSource } from './token-source';
import { discardBody, githubRequest, readGitHubJson, type FetchLike } from './transport';

/**
 * The console app's installation tokens (ADR 0003 decision 6), mirroring the plugin's `ptlib/ghapp.py`: an RS256
 * JWT signed with Web Crypto (no dependency in the credential path), the installation looked up per repository,
 * a token minted per repository and downscoped to read-only at mint, cached per isolate until 5 minutes before
 * it expires. Neither the JWT nor a token is ever logged, persisted or returned to a client.
 */

/** Decision 2(a): reads only, whatever the app itself may do (it holds Issues: write for owner connections). */
export const INSTALLATION_PERMISSIONS: Readonly<Record<string, 'read'>> = Object.freeze({
  metadata: 'read',
  issues: 'read',
  pull_requests: 'read',
  contents: 'read',
  actions: 'read',
});

// GitHub tolerates little clock drift: backdate iat, and keep exp under the 10-minute maximum.
const JWT_BACKDATE_S = 60;
const JWT_LIFETIME_S = 9 * 60;
// An installation token lives an hour; renew with the plugin's margin so a request never holds an expired one.
const RENEW_MARGIN_MS = 5 * 60 * 1000;

// Numeric app id, or the client id (`Iv…`), which GitHub also accepts as `iss`.
const APP_ID_PATTERN = /^(?:[1-9][0-9]*|Iv[A-Za-z0-9.]+)$/;
// Decision 6: PKCS#8 only. A PKCS#1 key (`BEGIN RSA …`) is converted on the owner's machine, never here.
const PKCS8_PEM = /^-----BEGIN PRIVATE KEY-----\r?\n([A-Za-z0-9+/=\r\n]+)-----END PRIVATE KEY-----$/;

export interface GitHubAppCredentials {
  /** `GITHUB_APP_ID` (a var). */
  readonly appId: string;
  /** `GITHUB_APP_PRIVATE_KEY` (a secret), PKCS#8 PEM. */
  readonly privateKeyPem: string;
}

export interface GitHubAppAuthOptions {
  readonly fetch: FetchLike;
  /** Milliseconds since the epoch; a seam for expiry tests. */
  readonly now?: () => number;
}

interface CachedToken {
  readonly token: string;
  readonly expiresAt: number;
}

/** 503 `github-auth`: this Worker's app credential is unusable, whatever GitHub would say. */
function misconfigured(detail: string): GitHubError {
  return githubAuthError(detail);
}

function base64UrlOf(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function base64UrlOfJson(value: unknown): string {
  return base64UrlOf(new TextEncoder().encode(JSON.stringify(value)));
}

/**
 * Imports `GITHUB_APP_PRIVATE_KEY` for RS256 signing. Anything but a PKCS#8 PEM is a misconfigured Worker:
 * 503 `github-auth`, with a detail that names the fix and nothing of the key.
 */
export async function importAppPrivateKey(pem: string): Promise<CryptoKey> {
  const match = PKCS8_PEM.exec(pem.trim());
  const body = match?.[1];
  if (body === undefined) {
    throw misconfigured('The GitHub App key must be a PKCS#8 PEM (convert it with openssl pkcs8 -topk8)');
  }
  let der: Uint8Array;
  try {
    der = Uint8Array.from(atob(body.replace(/[\r\n]/g, '')), (char) => char.charCodeAt(0));
  } catch {
    throw misconfigured('The GitHub App key is not valid base64');
  }
  try {
    return await crypto.subtle.importKey(
      'pkcs8',
      der,
      { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
      false,
      ['sign'],
    );
  } catch {
    // The runtime's message says nothing useful and must not reach a log next to key material.
    throw misconfigured('The GitHub App key is not an RSA key in PKCS#8 form');
  }
}

/** The app JWT: RS256, `iat = now − 60 s`, `exp = now + 9 min`, `iss = appId`. */
export async function createAppJwt(key: CryptoKey, appId: string, nowMs: number): Promise<string> {
  const now = Math.floor(nowMs / 1000);
  const signingInput = `${base64UrlOfJson({ alg: 'RS256', typ: 'JWT' })}.${base64UrlOfJson({
    iat: now - JWT_BACKDATE_S,
    exp: now + JWT_LIFETIME_S,
    iss: appId,
  })}`;
  const signature = await crypto.subtle.sign(
    'RSASSA-PKCS1-v1_5',
    key,
    new TextEncoder().encode(signingInput),
  );
  return `${signingInput}.${base64UrlOf(new Uint8Array(signature))}`;
}

function isInstallation(value: unknown): value is { id: number } {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const id = (value as Record<string, unknown>)['id'];
  return typeof id === 'number' && Number.isSafeInteger(id) && id > 0;
}

function isMintedToken(
  value: unknown,
): value is { token: string; expires_at: string; permissions: unknown; repository_selection: unknown } {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const record = value as Record<string, unknown>;
  return (
    typeof record['token'] === 'string' &&
    /^\S+$/.test(record['token']) &&
    typeof record['expires_at'] === 'string'
  );
}

// The only request this Worker ever sends: one repository (#9 threat row 2), so `repository_selection` can
// never legitimately come back as anything else.
const REQUESTED_REPOSITORY_SELECTION = 'selected';

/**
 * Whether a minted token's `permissions` and `repository_selection` are exactly what was requested
 * (`INSTALLATION_PERMISSIONS`, one repository). GitHub is expected to always downscope to the request, but a
 * token that came back broader — or scoped to more than one repository — must never be used as if it were not.
 */
function isDownscopedAsRequested(body: { permissions: unknown; repository_selection: unknown }): boolean {
  if (body.repository_selection !== REQUESTED_REPOSITORY_SELECTION) {
    return false;
  }
  if (typeof body.permissions !== 'object' || body.permissions === null || Array.isArray(body.permissions)) {
    return false;
  }
  const received = body.permissions as Record<string, unknown>;
  const wantedKeys = Object.keys(INSTALLATION_PERMISSIONS);
  if (Object.keys(received).length !== wantedKeys.length) {
    return false;
  }
  return wantedKeys.every((key) => received[key] === INSTALLATION_PERMISSIONS[key]);
}

/**
 * One per isolate (the api Worker keeps it for the isolate's lifetime): the token cache lives here, so a new
 * deployment — the only way the key or the app id changes — starts empty.
 */
export class GitHubAppAuth {
  private readonly fetcher: FetchLike;
  private readonly now: () => number;
  private signingKey: CryptoKey | undefined;
  private readonly tokens = new Map<string, CachedToken>();
  /** Concurrent requests for one repository share a mint instead of each spending two subrequests. */
  private readonly minting = new Map<string, Promise<CachedToken>>();

  constructor(
    private readonly credentials: GitHubAppCredentials,
    options: GitHubAppAuthOptions,
  ) {
    this.fetcher = options.fetch;
    this.now = options.now ?? (() => Date.now());
  }

  /**
   * The installation of the console app on `repo` (JWT call). Not installed → 409 `github-app-not-installed`
   * with the repository in `detail`, the Settings screen's "install the app" state (#15 stores the id).
   */
  async installationIdFor(repo: RepoName): Promise<number> {
    const jwt = await this.jwt();
    const response = await githubRequest(this.fetcher, {
      method: 'GET',
      path: githubPath`/repos/${repo}/installation`,
      bearer: jwt,
    });
    if (response.status === 404) {
      await discardBody(response);
      await this.assertAppExists(jwt);
      throw appNotInstalledError(repo.fullName);
    }
    if (!response.ok) {
      await discardBody(response);
      throw mapGitHubResponse(response, this.now());
    }
    const body = await readGitHubJson(response);
    if (!isInstallation(body)) {
      throw githubUnexpectedError('GitHub returned no installation id', response.status);
    }
    return body.id;
  }

  /**
   * GitHub answers 404 "Integration not found" — not 401 — to a JWT whose `iss` names no app (verified against
   * api.github.com on 2026-09-30), so a lookup 404 alone cannot tell "not installed" from a wrong
   * `GITHUB_APP_ID`. `GET /app` with the same JWT can: only when it succeeds is the 404 really "install the app".
   * One extra subrequest, on the 404 path only.
   */
  private async assertAppExists(jwt: string): Promise<void> {
    const response = await githubRequest(this.fetcher, {
      method: 'GET',
      path: githubPath`/app`,
      bearer: jwt,
    });
    await discardBody(response);
    if (response.ok) {
      return;
    }
    if (response.status === 404 || response.status === 401) {
      throw githubAuthError('GitHub knows no app with this GITHUB_APP_ID and key', response.status);
    }
    throw mapGitHubResponse(response, this.now());
  }

  /** Read-only token source for one repository, for `new GitHubClient(fetch, source)`. */
  tokenSourceFor(repo: RepoName): InstallationTokenSource {
    return {
      kind: 'installation',
      repo,
      getToken: async () => this.tokenFor(repo),
      invalidate: (token) => this.invalidate(repo, token),
    };
  }

  /** Whether a read for `repo` would go out without minting first (no installation lookup, no mint). */
  hasUsableToken(repo: RepoName): boolean {
    const cached = this.tokens.get(this.cacheKey(repo));
    return cached !== undefined && cached.expiresAt - RENEW_MARGIN_MS > this.now();
  }

  private cacheKey(repo: RepoName): string {
    return repo.fullName.toLowerCase();
  }

  private async tokenFor(repo: RepoName): Promise<string> {
    const key = this.cacheKey(repo);
    const cached = this.tokens.get(key);
    if (cached !== undefined && cached.expiresAt - RENEW_MARGIN_MS > this.now()) {
      return cached.token;
    }
    this.tokens.delete(key);
    let pending = this.minting.get(key);
    if (pending === undefined) {
      pending = this.mint(repo);
      this.minting.set(key, pending);
    }
    try {
      const minted = await pending;
      return minted.token;
    } finally {
      if (this.minting.get(key) === pending) {
        this.minting.delete(key);
      }
    }
  }

  private invalidate(repo: RepoName, token: string): void {
    const key = this.cacheKey(repo);
    if (this.tokens.get(key)?.token === token) {
      this.tokens.delete(key);
    }
  }

  private async mint(repo: RepoName): Promise<CachedToken> {
    const installationId = await this.installationIdFor(repo);
    const response = await githubRequest(this.fetcher, {
      method: 'POST',
      path: githubPath`/app/installations/${installationId}/access_tokens`,
      bearer: await this.jwt(),
      body: { repositories: [repo.name], permissions: INSTALLATION_PERMISSIONS },
    });
    if (!response.ok) {
      await discardBody(response);
      throw mapGitHubResponse(response, this.now());
    }
    const body = await readGitHubJson(response);
    const expiresAt = isMintedToken(body) ? Date.parse(body.expires_at) : Number.NaN;
    if (!isMintedToken(body) || Number.isNaN(expiresAt)) {
      throw githubUnexpectedError('GitHub returned no installation token', response.status);
    }
    // #76: refuse a token GitHub minted with different permissions or repository scope than requested, never
    // use it as if it were downscoped.
    if (!isDownscopedAsRequested(body)) {
      throw githubUnexpectedError(
        'GitHub minted a token with different permissions or repository scope than requested',
        response.status,
      );
    }
    const entry: CachedToken = { token: body.token, expiresAt };
    this.tokens.set(this.cacheKey(repo), entry);
    return entry;
  }

  private async jwt(): Promise<string> {
    const appId = this.credentials.appId.trim();
    if (!APP_ID_PATTERN.test(appId)) {
      throw misconfigured('GITHUB_APP_ID is not set to the console app id on this Worker');
    }
    this.signingKey ??= await importAppPrivateKey(this.credentials.privateKeyPem);
    return createAppJwt(this.signingKey, appId, this.now());
  }
}
