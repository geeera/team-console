import { createLogger, type Logger } from '@worker/core';
import {
  appNotInstalledError,
  appNotInstalledForAccountError,
  githubAuthError,
  GitHubError,
  githubUnexpectedError,
  mapGitHubResponse,
} from './errors';
import { githubPath } from './github-path';
import type { RepoName } from './repo-name';
import {
  SCOPED_MINT_PERMISSIONS,
  SCOPED_REVOKE_FAILURE,
  SWITCHED_SCOPED_KINDS,
  ScopedInstallationToken,
  assertScopedTarget,
  scopedMintFailureOf,
  setupWriteDisabledError,
  type ScopedMintAudit,
  type ScopedMintFacts,
  type ScopedMintKind,
  type ScopedMintTarget,
} from './scoped-mint';
import type { InstallationListTokenSource, InstallationTokenSource } from './token-source';
import {
  discardBody,
  githubRequest,
  readGitHubJson,
  type FetchLike,
  type GitHubRequest,
  type GitHubTransportOptions,
} from './transport';

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
  // #197: private repositories refuse check-runs reads without it (public ones serve them anyway).
  checks: 'read',
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
  /** Seam for tests: overrides every request's deadline signal (default `AbortSignal.timeout(GITHUB_DEADLINE_MS)`). */
  readonly deadlineSignal?: () => AbortSignal;
  /** Where a failed revoke of a refused token is reported (#317); defaults to a redacting JSON line on stdout. */
  readonly logger?: Logger;
  /**
   * #759 kill switch: whether the `workflow-pr` mint may run at all. Off unless set to `enabled` (the api Worker sets
   * it from `ALLOW_ACTIONS_SETUP_WRITE`); off, that mint is refused with 503 `github-write-disabled` before any request.
   */
  readonly setupWrite?: 'enabled' | 'disabled';
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

export type PermissionLevel = 'read' | 'write' | 'admin';

/** #759: an installation's granted permissions, as `readInstallationPermissions` reduces GitHub's answer. */
export interface InstallationPermissions {
  /** Permission name → level; names GitHub sends with any other value are left out. */
  readonly permissions: Readonly<Record<string, PermissionLevel>>;
  /** The installation's settings page, where an installer accepts updated permissions; `null` unless on github.com. */
  readonly htmlUrl: string | null;
  /** `<app_slug>[bot]`, the login of the app's own commits and PRs; `null` when GitHub names no usable slug. */
  readonly botLogin: string | null;
  readonly suspended: boolean;
}

const LEVEL_RANK: Readonly<Record<PermissionLevel, number>> = { read: 1, write: 2, admin: 3 };

/** Whether the installation was granted every permission of `wanted`, at its level or above. */
export function installationGrants(
  installation: InstallationPermissions,
  wanted: Readonly<Record<string, 'read' | 'write'>>,
): boolean {
  return Object.entries(wanted).every(([name, level]) => {
    const granted = installation.permissions[name];
    return granted !== undefined && LEVEL_RANK[granted] >= LEVEL_RANK[level];
  });
}

const PERMISSION_LEVELS: ReadonlySet<unknown> = new Set(['read', 'write', 'admin']);
const PERMISSION_NAME = /^[a-z_]{1,64}$/;
// GitHub app slugs: lower-case letters, digits and dashes.
const APP_SLUG = /^[a-z0-9][a-z0-9-]{0,63}$/;
const GITHUB_UI_URL = /^https:\/\/github\.com\/[^\s"'<>\\]*$/;

/** The reduced installation, or `null` when the answer is not an installation of `installationId`. */
function installationPermissionsOf(value: unknown, installationId: number): InstallationPermissions | null {
  if (!isInstallation(value) || value.id !== installationId) {
    return null;
  }
  const record = value as unknown as Record<string, unknown>;
  const granted = record['permissions'];
  if (typeof granted !== 'object' || granted === null || Array.isArray(granted)) {
    return null;
  }
  const permissions: Record<string, PermissionLevel> = {};
  for (const [name, level] of Object.entries(granted as Record<string, unknown>)) {
    if (PERMISSION_NAME.test(name) && PERMISSION_LEVELS.has(level)) {
      permissions[name] = level as PermissionLevel;
    }
  }
  const htmlUrl = record['html_url'];
  const slug = record['app_slug'];
  return {
    permissions: Object.freeze(permissions),
    htmlUrl: typeof htmlUrl === 'string' && GITHUB_UI_URL.test(htmlUrl) ? htmlUrl : null,
    botLogin: typeof slug === 'string' && APP_SLUG.test(slug) ? `${slug}[bot]` : null,
    suspended: record['suspended_at'] !== null && record['suspended_at'] !== undefined,
  };
}

function hasNextPage(response: Response): boolean {
  return /rel="next"/.test(response.headers.get('link') ?? '');
}

interface MintedToken {
  readonly token: string;
  readonly expires_at: string;
  readonly permissions: unknown;
  readonly repository_selection: unknown;
  readonly repositories: unknown;
}

/** The token of a mint answer, when it has one that could be sent as a bearer (and so revoked). */
function mintedTokenOf(value: unknown): string | undefined {
  if (typeof value !== 'object' || value === null) {
    return undefined;
  }
  const token = (value as Record<string, unknown>)['token'];
  return typeof token === 'string' && /^\S+$/.test(token) ? token : undefined;
}

function isMintedToken(value: unknown): value is MintedToken {
  return (
    mintedTokenOf(value) !== undefined && typeof (value as Record<string, unknown>)['expires_at'] === 'string'
  );
}

/**
 * What a mint asked GitHub for, and what its answer must echo. A repository token (#9 threat row 2) asks for one
 * repository, so `repository_selection` can only legitimately come back `selected`. The installation-wide list token
 * (#194) names no repositories, so GitHub answers with the installation's own selection (`all` or `selected`) —
 * either is fine for a `metadata`-only token; its permissions still have to be exactly `metadata: read`.
 */
interface MintExpectation {
  readonly permissions: Readonly<Record<string, 'read' | 'write'>>;
  readonly repositorySelections: readonly string[];
  /** #317: the one repository a repository token must be for; `null` for the installation-wide list token. */
  readonly repository: RepoName | null;
  /** #670: the one repository, by id, an Actions dispatch token must be for. */
  readonly repositoryId?: number;
  /** #670: an echoed `metadata: read` (implicit on every app token) is not counted as a broader scope. */
  readonly toleratesMetadata?: boolean;
}

function repoMint(repository: RepoName): MintExpectation {
  return { permissions: INSTALLATION_PERMISSIONS, repositorySelections: ['selected'], repository };
}

const LIST_MINT: MintExpectation = Object.freeze({
  permissions: INSTALLATION_LIST_PERMISSIONS,
  repositorySelections: Object.freeze(['all', 'selected']),
  repository: null,
});

/**
 * Whether a minted token's `permissions` and `repository_selection` are exactly what was requested. GitHub is
 * expected to always downscope to the request, but a token that came back broader — or, for a repository token,
 * scoped to more than one repository — must never be used as if it were not.
 */
function isDownscopedAsRequested(
  body: { permissions: unknown; repository_selection: unknown },
  expected: MintExpectation,
): boolean {
  if (
    typeof body.repository_selection !== 'string' ||
    !expected.repositorySelections.includes(body.repository_selection)
  ) {
    return false;
  }
  if (typeof body.permissions !== 'object' || body.permissions === null || Array.isArray(body.permissions)) {
    return false;
  }
  const received = { ...(body.permissions as Record<string, unknown>) };
  // Every app token can read metadata; GitHub may echo it on a token that did not ask for it, which is no broader.
  if (expected.toleratesMetadata === true && received['metadata'] === 'read') {
    delete received['metadata'];
  }
  const wantedKeys = Object.keys(expected.permissions);
  if (Object.keys(received).length !== wantedKeys.length) {
    return false;
  }
  return wantedKeys.every((key) => received[key] === expected.permissions[key]);
}

/**
 * #317: a repository token is for exactly the requested repository — `repositories` must list that one and no
 * other. A missing or malformed list is refused too: GitHub always lists the repositories a scoped token covers.
 * Matched on `full_name`, case-insensitively, since a `RepoName` carries no repository id to compare.
 */
function coversOnly(repositories: unknown, repo: RepoName): boolean {
  if (!Array.isArray(repositories) || repositories.length !== 1) {
    return false;
  }
  const [entry] = repositories as unknown[];
  if (typeof entry !== 'object' || entry === null) {
    return false;
  }
  const fullName = (entry as Record<string, unknown>)['full_name'];
  return typeof fullName === 'string' && fullName.toLowerCase() === repo.fullName.toLowerCase();
}

/** #670: the dispatch token lists exactly the one repository it was minted for, by id. */
function coversOnlyId(repositories: unknown, repositoryId: number): boolean {
  if (!Array.isArray(repositories) || repositories.length !== 1) {
    return false;
  }
  const [entry] = repositories as unknown[];
  return typeof entry === 'object' && entry !== null && (entry as Record<string, unknown>)['id'] === repositoryId;
}

type MintVerdict =
  | { readonly accepted: true; readonly entry: CachedToken }
  | { readonly accepted: false; readonly detail: string };

/** Whether a mint answer's token may be used and cached, or why it is refused. */
function judgeMint(minted: unknown, expected: MintExpectation): MintVerdict {
  const expiresAt = isMintedToken(minted) ? Date.parse(minted.expires_at) : Number.NaN;
  if (!isMintedToken(minted) || Number.isNaN(expiresAt)) {
    return { accepted: false, detail: 'GitHub returned no installation token' };
  }
  // #76: refuse a token GitHub minted with different permissions or repository scope than requested, never
  // use it as if it were downscoped.
  if (!isDownscopedAsRequested(minted, expected)) {
    return {
      accepted: false,
      detail: 'GitHub minted a token with different permissions or repository scope than requested',
    };
  }
  if (expected.repository !== null && !coversOnly(minted.repositories, expected.repository)) {
    return { accepted: false, detail: 'GitHub minted a token for other repositories than the one requested' };
  }
  if (expected.repositoryId !== undefined && !coversOnlyId(minted.repositories, expected.repositoryId)) {
    return { accepted: false, detail: 'GitHub minted a token for other repositories than the one requested' };
  }
  return { accepted: true, entry: { token: minted.token, expiresAt } };
}

/**
 * One per isolate (the api Worker keeps it for the isolate's lifetime): the token cache lives here, so a new
 * deployment — the only way the key or the app id changes — starts empty.
 */
export class GitHubAppAuth {
  private readonly fetcher: FetchLike;
  private readonly now: () => number;
  private readonly transportOptions: GitHubTransportOptions;
  private readonly logger: Logger;
  private readonly setupWrite: 'enabled' | 'disabled';
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
    this.transportOptions =
      options.deadlineSignal === undefined ? {} : { deadlineSignal: options.deadlineSignal };
    this.logger = options.logger ?? createLogger({ component: 'github-app-auth' });
    this.setupWrite = options.setupWrite ?? 'disabled';
  }

  /** Every GitHub call this instance makes, with its (possibly test-shortened) deadline signal. */
  private request(request: GitHubRequest): Promise<Response> {
    return githubRequest(this.fetcher, request, this.transportOptions);
  }

  /**
   * The installation of the console app on `repo` (JWT call). Not installed → 409 `github-app-not-installed`
   * with the repository in `detail`, the Settings screen's "install the app" state (#15 stores the id).
   */
  async installationIdFor(repo: RepoName): Promise<number> {
    const jwt = await this.jwt();
    const response = await this.request({
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
    const response = await this.request({
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
    const response = await this.request({
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

  /**
   * #759: what the installation was granted, `GET /app/installations/{installation_id}` with the app JWT, so it
   * mints nothing. An installer who has not accepted an update of the app's permissions keeps the old set until they
   * do, and this read shows which. `null` when GitHub knows no such installation (a wrong app id answers 503
   * `github-auth`, as `installationIdFor`). The answer is reduced to permission levels, the settings page (only an
   * `https://github.com/` URL) and the app's bot login; the account, its login and dates are not passed on.
   */
  async readInstallationPermissions(installationId: number): Promise<InstallationPermissions | null> {
    if (!Number.isSafeInteger(installationId) || installationId <= 0) {
      throw new RangeError('an installation is named by a positive integer id');
    }
    const jwt = await this.jwt();
    const response = await this.request({
      method: 'GET',
      path: githubPath`/app/installations/${installationId}`,
      bearer: jwt,
    });
    if (response.status === 404) {
      await discardBody(response);
      await this.assertAppExists(jwt);
      return null;
    }
    if (!response.ok) {
      await discardBody(response);
      throw mapGitHubResponse(response, this.now());
    }
    const body = await readGitHubJson(response);
    const granted = installationPermissionsOf(body, installationId);
    if (granted === null) {
      throw githubUnexpectedError('GitHub returned an installation of an unexpected shape', response.status);
    }
    return granted;
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
    return this.mint(
      installationId,
      { repositories: [repo.name], permissions: INSTALLATION_PERMISSIONS },
      repoMint(repo),
    );
  }

  /**
   * A token for one repository with exactly the permissions of `kind` (#670, #759), never cached, stored or logged.
   * The caller passes it to `revokeScoped` in `finally`.
   * - `kind` is a string literal at the call site, from a module `scoped-mint-kinds.spec.ts` allows for that kind; at
   *   run time it must be an own key of `SCOPED_MINT_PERMISSIONS` (a TypeError otherwise, before anything is audited).
   * - `target` is the project row's installation and repository ids, never request input.
   * - GitHub's answer is judged like `mintForRepo`'s; a wider or other scope is revoked and refused (502, GitHub's
   *   2xx status).
   * - Errors: 503 `github-write-disabled` for `workflow-pr` while the kill switch is off; a `GitHubError` with
   *   `githubStatus` 422 when the installer has not accepted the permission (the readiness check reads that as
   *   `unknown`, never ok); GitHub's other failures as `mapGitHubResponse` maps them.
   * - `audit` hears `attempted` before the request, then `minted` or `failed`.
   */
  async mintScoped<K extends ScopedMintKind>(
    kind: K,
    target: ScopedMintTarget,
    audit: ScopedMintAudit,
  ): Promise<ScopedInstallationToken<K>> {
    // A cast or a prototype key (`'constructor'`, `'__proto__'`) must never reach the permission lookup.
    if (typeof kind !== 'string' || !Object.hasOwn(SCOPED_MINT_PERMISSIONS, kind)) {
      throw new TypeError('unknown scoped mint kind');
    }
    assertScopedTarget(target);
    const facts: ScopedMintFacts = {
      kind,
      installationId: target.installationId,
      repositoryId: target.repositoryId,
    };
    await audit({ ...facts, outcome: 'attempted' });
    let bearer: string;
    try {
      if (SWITCHED_SCOPED_KINDS.has(kind) && this.setupWrite !== 'enabled') {
        throw setupWriteDisabledError();
      }
      const permissions = SCOPED_MINT_PERMISSIONS[kind];
      const minted = await this.mint(
        target.installationId,
        { repository_ids: [target.repositoryId], permissions },
        {
          permissions,
          repositorySelections: ['selected'],
          repository: null,
          repositoryId: target.repositoryId,
          toleratesMetadata: true,
        },
      );
      bearer = minted.token;
    } catch (error: unknown) {
      await this.auditFailure(audit, facts, error);
      throw error;
    }
    const token = new ScopedInstallationToken(kind, target.installationId, target.repositoryId, bearer);
    try {
      await audit({ ...facts, outcome: 'minted' });
    } catch (error: unknown) {
      await this.revokeScoped(token);
      throw error;
    }
    return token;
  }

  /**
   * #723 item 1: best-effort `DELETE /installation/token` for a scoped token once its calls are made, whatever they
   * answered, so it does not stay live at GitHub for the rest of its hour. Never throws: a failure is only logged,
   * with GitHub's status or the error type, never the token.
   */
  async revokeScoped(token: ScopedInstallationToken): Promise<void> {
    await this.revoke(token.bearer(), token.installationId, SCOPED_REVOKE_FAILURE[token.kind]);
  }

  private async auditFailure(audit: ScopedMintAudit, facts: ScopedMintFacts, error: unknown): Promise<void> {
    try {
      await audit({
        ...facts,
        outcome: 'failed',
        failure: scopedMintFailureOf(error),
        githubStatus: error instanceof GitHubError ? error.githubStatus : null,
      });
    } catch (auditError: unknown) {
      // The mint's own failure is what the caller must see; the lost audit row is reported here instead.
      this.logger.error('scoped mint failure not audited', {
        kind: facts.kind,
        installationId: facts.installationId,
        repositoryId: facts.repositoryId,
        reason: auditError instanceof Error ? auditError.name : 'unknown',
      });
    }
  }

  /** No `repositories` member — that is what makes it installation-wide — hence `metadata` and nothing else. */
  private async mintForInstallation(installationId: number): Promise<CachedToken> {
    return this.mint(installationId, { permissions: INSTALLATION_LIST_PERMISSIONS }, LIST_MINT);
  }

  private async mint(
    installationId: number,
    body: Readonly<Record<string, unknown>>,
    expected: MintExpectation,
  ): Promise<CachedToken> {
    const response = await this.request({
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
    const verdict = judgeMint(minted, expected);
    if (verdict.accepted) {
      return verdict.entry;
    }
    const refusedToken = mintedTokenOf(minted);
    if (refusedToken !== undefined) {
      await this.revoke(refusedToken, installationId, 'refused installation token not revoked');
    }
    throw githubUnexpectedError(verdict.detail, response.status);
  }

  /**
   * #317: best-effort `DELETE /installation/token` for a token the console refused (or is done with, #723), which
   * would otherwise stay live at GitHub for up to an hour. A failure is only logged — with GitHub's status or the
   * error type, never the token — and never replaces the refusal the caller is about to throw.
   */
  private async revoke(token: string, installationId: number, failure: string): Promise<void> {
    try {
      const response = await this.request({
        method: 'DELETE',
        path: githubPath`/installation/token`,
        bearer: token,
      });
      await discardBody(response);
      if (!response.ok) {
        this.logger.warn(failure, {
          installationId,
          githubStatus: response.status,
        });
      }
    } catch (error: unknown) {
      this.logger.warn(failure, {
        installationId,
        reason: error instanceof GitHubError ? error.problem.type : 'unexpected-error',
      });
    }
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
