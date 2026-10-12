import type { RepoName } from './repo-name';

/**
 * Where `GitHubClient` gets its bearer token (ADR 0003 decisions 2 and 6). The client never holds a token
 * string of its own, so there is nothing to log or leak on the client object.
 */
export interface TokenSource {
  /**
   * Who the requests speak as: `installation` reads one repository as the app, `owner` writes as the owner (#10),
   * `installation-list` lists the installation's repositories and nothing else (#194).
   */
  readonly kind: 'installation' | 'owner' | 'installation-list';
  /** A token for the next request; may mint or refresh. Failures are `GitHubError`s. */
  getToken(): Promise<string>;
  /** GitHub answered 401 to this token: the next `getToken()` must not return it. */
  invalidate(token: string): void;
}

/** Read-only installation token of the console app, downscoped to one repository at mint (decision 2(a)). */
export interface InstallationTokenSource extends TokenSource {
  readonly kind: 'installation';
  readonly repo: RepoName;
}

/**
 * The installation-wide token, `metadata: read` only, with no `repositories` member at mint (decision 2(a) as
 * amended by #194). `metadata` still reads collaborators, events, commit comments and more on every repository in
 * the installation, so `GitHubClient` accepts this source in `listInstallationRepositories` only (decision 6).
 */
export interface InstallationListTokenSource extends TokenSource {
  readonly kind: 'installation-list';
  readonly installationId: number;
}

/** The connected owner account, pinned at connect (ADR 0003 decisions 2(b) and 4). */
export interface OwnerAccount {
  readonly login: string;
  readonly userId: number;
}

/**
 * The owner's user access token (`ghu_…`), implemented by #59 and consumed by owner writes (#10). Before
 * every write the caller compares the repository's `owner.login`/`owner.id` with `account()` (decision 2(b)).
 * Without a connection `getToken()` fails with 403 `github-owner-not-connected`; there is never a fallback.
 */
export interface OwnerTokenSource extends TokenSource {
  readonly kind: 'owner';
  account(): Promise<OwnerAccount>;
}

/**
 * What the generic reads and writes of `GitHubClient` accept: a per-repository installation token or the owner's
 * token. A `TokenSource` whose kind is `installation-list` does not fit, so passing one is a type error.
 */
export type RequestTokenSource = TokenSource & { readonly kind: 'installation' | 'owner' };
