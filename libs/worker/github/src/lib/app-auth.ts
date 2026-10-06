import {
  appNotInstalledError,
  appNotInstalledForAccountError,
  githubAuthError,
  githubUnexpectedError,
  type GitHubError,
  mapGitHubResponse,
} from './errors';
import { githubPath } from './github-path';
import type { RepoName } from './repo-name';
import type { InstallationListTokenSource, InstallationTokenSource } from './token-source';
import { discardBody, githubRequest, readGitHubJson, type FetchLike } from './transport';

/**
 * The console app's installation tokens (ADR 0003 decision 6), mirroring the plugin's `ptlib/ghapp.py`: an RS256
 * JWT signed with Web Crypto (no dependency in the credential path), the installation looked up per repository,
 * a token minted per repository and downscoped to read-only at mint, cached per isolate until 5 minutes before
 * it expires. #194 adds one installation-wide token per installation, `metadata: read` only, for the installation's
 * repository list. Neither the JWT nor a token is ever logged, persisted or returned to a client.
 */

/** Decision 2(a): reads only, whatever the app itself may do (it holds Issues: write for owner connections). */
export const INSTALLATION_PERMISSIONS: Readonly<Record<string, 'read'>> = Object.freeze({
  metadata: 'read',
  issues: 'read',
  pull_requests: 'read',
  contents: 'read',
  actions: 'read',
});

/**
 * #194 (decision 2(a) as amended): the installation-wide list token. With no `repositories` member in the mint body
 * it covers every repository of the installation, so it carries `metadata` and nothing else.
 */
export const INSTALLATION_LIST_PERMISSIONS: Readonly<Record<string, 'read'>> = Object.freeze({
  metadata: 'read',
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

function isInstallationOfAccount(value: unknown): value is { id: number; account: { id: number } } {
  if (!isInstallation(value)) {
    return false;
  }
  const account = (value as Record<string, unknown>)['account'];
  return (
    typeof account === 'object' &&
    account !== null &&
    Number.isSafeInteger((account as Record<string, unknown>)['id'])
  );
}

function hasNextPage(response: Response): boolean {
  return /rel="next"/.test(response.headers.get('link') ?? '');
}

function isMintedToken(value: unknown): value is { token: string; expires_at: string } {
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

/**
 * One per isolate (the api Worker keeps it for the isolate's lifetime): the token cache lives here, so a new
 * deployment — the only way the key or the app id changes — starts empty.
 */
export class GitHubAppAuth {
  private readonly fetcher: FetchLike;
  private readonly now: () => number;
  private signingKey: CryptoKey | undefined;
  private readonly tokens = new Map<string, CachedToken>();
  /** Concurrent requests for one token share a mint instead of each spending two subrequests. */
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

  /**
   * The console app's installation on the connected owner's account (#194): `GET /app/installations` with the JWT,
   * matched on `account.id` against the pinned `user_id` of the #59 connection — never on a login, which can be
   * renamed. First page only: ADR 0003 supports one installation per account ("Not yet" for more). No match →
   * 409 `github-app-not-installed`; no match while GitHub names more pages → 502 `github-unexpected`.
   */
  async installationIdForAccount(userId: number): Promise<number> {
    const jwt = await this.jwt();
    const response = await githubRequest(this.fetcher, {
      method: 'GET',
      path: githubPath`/app/installations?per_page=${100}`,
      bearer: jwt,
    });
    if (response.status === 404) {
      await discardBody(response);
      // A wrong GITHUB_APP_ID answers 404 here too: that is 503 github-auth, never "not installed".
      await this.assertAppExists(jwt);
      throw githubUnexpectedError('GitHub listed no installations for an existing app', response.status);
    }
    if (!response.ok) {
      await discardBody(response);
      throw mapGitHubResponse(response, this.now());
    }
    const body = await readGitHubJson(response);
    if (!Array.isArray(body) || !body.every(isInstallationOfAccount)) {
      throw githubUnexpectedError('GitHub returned installations of an unexpected shape', response.status);
    }
    const match = body.find((installation) => installation.account.id === userId);
    if (match !== undefined) {
      return match.id;
    }
    if (hasNextPage(response)) {
      throw githubUnexpectedError(
        'The app has more installations than the console supports',
        response.status,
      );
    }
    throw appNotInstalledForAccountError();
  }

  /** Read-only token source for one repository, for `new GitHubClient(fetch, source)`. */
  tokenSourceFor(repo: RepoName): InstallationTokenSource {
    const key = this.repoKey(repo);
    return {
      kind: 'installation',
      repo,
      getToken: async () => this.tokenFor(key, () => this.mintForRepo(repo)),
      invalidate: (token) => this.invalidate(key, token),
    };
  }

  /**
   * The installation-wide `metadata` token (#194), for `GitHubClient.listInstallationRepositories` only. Its cache
   * key cannot collide with a repository's: a `:` never occurs in a repository full name.
   */
  listTokenSourceFor(installationId: number): InstallationListTokenSource {
    const key = this.listKey(installationId);
    return {
      kind: 'installation-list',
      installationId,
      getToken: async () => this.tokenFor(key, () => this.mintForInstallation(installationId)),
      invalidate: (token) => this.invalidate(key, token),
    };
  }

  /** Whether a read for `repo` would go out without minting first (no installation lookup, no mint). */
  hasUsableToken(repo: RepoName): boolean {
    return this.isUsable(this.repoKey(repo));
  }

  /** Whether the installation's list token is cached outside the renewal margin (no mint needed). */
  hasUsableListToken(installationId: number): boolean {
    return this.isUsable(this.listKey(installationId));
  }

  private repoKey(repo: RepoName): string {
    return repo.fullName.toLowerCase();
  }

  private listKey(installationId: number): string {
    return `installation:${installationId}`;
  }

  private isUsable(key: string): boolean {
    const cached = this.tokens.get(key);
    return cached !== undefined && cached.expiresAt - RENEW_MARGIN_MS > this.now();
  }

  private async tokenFor(key: string, mint: () => Promise<CachedToken>): Promise<string> {
    const cached = this.tokens.get(key);
    if (cached !== undefined && cached.expiresAt - RENEW_MARGIN_MS > this.now()) {
      return cached.token;
    }
    this.tokens.delete(key);
    let pending = this.minting.get(key);
    if (pending === undefined) {
      pending = (async () => {
        const entry = await mint();
        this.tokens.set(key, entry);
        return entry;
      })();
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

  private invalidate(key: string, token: string): void {
    if (this.tokens.get(key)?.token === token) {
      this.tokens.delete(key);
    }
  }

  private async mintForRepo(repo: RepoName): Promise<CachedToken> {
    const installationId = await this.installationIdFor(repo);
    return this.mint(installationId, { repositories: [repo.name], permissions: INSTALLATION_PERMISSIONS });
  }

  /** No `repositories` member — that is what makes it installation-wide — hence `metadata` and nothing else. */
  private async mintForInstallation(installationId: number): Promise<CachedToken> {
    return this.mint(installationId, { permissions: INSTALLATION_LIST_PERMISSIONS });
  }

  private async mint(installationId: number, body: Readonly<Record<string, unknown>>): Promise<CachedToken> {
    const response = await githubRequest(this.fetcher, {
      method: 'POST',
      path: githubPath`/app/installations/${installationId}/access_tokens`,
      bearer: await this.jwt(),
      body,
    });
    if (!response.ok) {
      await discardBody(response);
      throw mapGitHubResponse(response, this.now());
    }
    const minted = await readGitHubJson(response);
    const expiresAt = isMintedToken(minted) ? Date.parse(minted.expires_at) : Number.NaN;
    if (!isMintedToken(minted) || Number.isNaN(expiresAt)) {
      throw githubUnexpectedError('GitHub returned no installation token', response.status);
    }
    return { token: minted.token, expiresAt };
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
