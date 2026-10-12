import {
  requestBudgetError,
  type FetchLike,
  type InstallationListTokenSource,
  type RepoName,
} from '@worker/github';
import type { GitHubConnection } from '../github';

/** An installation token on a cold isolate: the installation lookup and the mint. */
const TOKEN_COST = 2;
/** `GET /app/installations`, and separately the list token's mint when it is not cached (#194). */
const INSTALLATIONS_LOOKUP_COST = 1;
const LIST_MINT_COST = 1;

/** The installation list's reads (#194): its installation, its `metadata` token source and a counted transport. */
export interface InstallationListConnection {
  readonly installationId: number;
  readonly source: InstallationListTokenSource;
  readonly fetch: FetchLike;
}

/**
 * GitHub subrequests one request may still spend (#27). Every read through `connectionFor`'s transport counts one;
 * a token that has to be minted first counts two, before it is minted. Once the next call would pass the limit it
 * fails with 503 `github-request-budget` without reaching GitHub, so a fan-out over many projects stops reading
 * instead of failing as a whole. Not counted (the caller keeps a margin for them): the extra `GET /app` behind a
 * "not installed" lookup and a mint after GitHub rejected a token (401).
 */
export class SubrequestBudget {
  private used = 0;

  constructor(readonly limit: number) {
    if (!Number.isSafeInteger(limit) || limit < 0) {
      throw new Error('the subrequest budget must be a non-negative integer');
    }
  }

  get spent(): number {
    return this.used;
  }

  /** Takes `count` from the budget, or throws `github-request-budget` and takes nothing. */
  spend(count: number): void {
    if (this.used + count > this.limit) {
      throw requestBudgetError();
    }
    this.used += count;
  }

  /** `base`, with every call taken from the budget first. */
  transport(base: FetchLike): FetchLike {
    return async (input, init) => {
      this.spend(1);
      return base(input, init);
    };
  }

  /** The connection for reads of `repo`: its token minted now if it must be, then a counted transport. */
  async connectionFor(github: GitHubConnection, repo: RepoName): Promise<GitHubConnection> {
    if (!github.auth.hasUsableToken(repo)) {
      this.spend(TOKEN_COST);
      await github.auth.tokenSourceFor(repo).getToken();
    }
    return { auth: github.auth, fetch: this.transport(github.fetch) };
  }

  /**
   * The installation of the connected account `userId` and its list token (#194). The lookup is always one
   * subrequest (the installation id is not cached apart from the list); the mint is one more on a cold token.
   */
  async listConnectionFor(github: GitHubConnection, userId: number): Promise<InstallationListConnection> {
    this.spend(INSTALLATIONS_LOOKUP_COST);
    const installationId = await github.auth.installationIdForAccount(userId);
    const source = github.auth.listTokenSourceFor(installationId);
    if (!github.auth.hasUsableListToken(installationId)) {
      this.spend(LIST_MINT_COST);
      await source.getToken();
    }
    return { installationId, source, fetch: this.transport(github.fetch) };
  }
}
