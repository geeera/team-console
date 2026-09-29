import type { MappedError } from '@worker/core';
import {
  GitHubAppAuth,
  GitHubError,
  MemoryReadCache,
  createMockGitHub,
  isGitHubMockEnabled,
  type FetchLike,
  type ReadCache,
} from '@worker/github';
import type { ApiEnv } from './env';

/** What a request needs to read GitHub: the app's token minting and the transport it goes through. */
export interface GitHubConnection {
  readonly auth: GitHubAppAuth;
  readonly fetch: FetchLike;
}

export interface ApiGitHubOptions {
  /** Test seam; the Worker uses the global `fetch`. */
  readonly fetch?: FetchLike;
  readonly readCache?: ReadCache;
}

/**
 * The api Worker's GitHub state for one isolate (created once in `createApiApp`): the app's installation-token
 * cache and the read cache. Mock mode (`GITHUB_MOCK=true`) is honoured only with `ENVIRONMENT=local`; on any
 * other environment the flag is ignored and the real app is used (#9 threat row 7).
 */
export class ApiGitHub {
  readonly readCache: ReadCache;
  private readonly fetcher: FetchLike;
  private real: { readonly appId: string; readonly pem: string; readonly auth: GitHubAppAuth } | undefined;
  private mock: Promise<GitHubConnection> | undefined;

  constructor(options: ApiGitHubOptions = {}) {
    // Wrapped: a Workers `fetch` stored on an object and called as its method throws "Illegal invocation".
    this.fetcher = options.fetch ?? (async (input, init) => fetch(input, init));
    this.readCache = options.readCache ?? new MemoryReadCache();
  }

  async connect(env: ApiEnv): Promise<GitHubConnection> {
    if (isGitHubMockEnabled(env)) {
      return this.mockConnection();
    }
    // Missing or malformed values fail inside GitHubAppAuth as 503 github-auth, before any request is sent.
    const appId = env.GITHUB_APP_ID ?? '';
    const pem = env.GITHUB_APP_PRIVATE_KEY ?? '';
    if (this.real === undefined || this.real.appId !== appId || this.real.pem !== pem) {
      this.real = {
        appId,
        pem,
        auth: new GitHubAppAuth({ appId, privateKeyPem: pem }, { fetch: this.fetcher }),
      };
    }
    return { auth: this.real.auth, fetch: this.fetcher };
  }

  private async mockConnection(): Promise<GitHubConnection> {
    this.mock ??= (async () => {
      const mock = await createMockGitHub();
      return { auth: new GitHubAppAuth(mock.credentials, { fetch: mock.fetch }), fetch: mock.fetch };
    })();
    try {
      return await this.mock;
    } catch (error: unknown) {
      this.mock = undefined;
      throw error;
    }
  }
}

/** `createWorkerApp`'s `mapError`: a GitHub failure becomes its Problem Details; GitHub's status goes to the log. */
export function mapGitHubError(error: unknown): MappedError | undefined {
  if (!(error instanceof GitHubError)) {
    return undefined;
  }
  return { problem: error.problem, logFields: { githubStatus: error.githubStatus } };
}
