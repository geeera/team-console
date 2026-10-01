import type { Logger, MappedError } from '@worker/core';
import { OwnerConnectionsRepo } from '@worker/db';
import {
  GitHubAppAuth,
  GitHubError,
  GitHubOAuth,
  MemoryReadCache,
  createMockGitHub,
  isGitHubLogin,
  isGitHubMockEnabled,
  type FetchLike,
  type ReadCache,
} from '@worker/github';
import type { ApiEnv } from './env';
import { OwnerConnection } from './owner/owner-connection';
import { loadOwnerKeys, ownerFlowMisconfigured } from './owner/owner-keys';

/** What a request needs to read GitHub: the app's token minting and the transport it goes through. */
export interface GitHubConnection {
  readonly auth: GitHubAppAuth;
  readonly fetch: FetchLike;
}

export interface ApiGitHubOptions {
  /** Test seam; the Worker uses the global `fetch`. */
  readonly fetch?: FetchLike;
  readonly readCache?: ReadCache;
  /** Milliseconds since the epoch; a seam for expiry and lease tests. */
  readonly now?: () => number;
  /** A seam for the refresh-lease waits. */
  readonly sleep?: (ms: number) => Promise<void>;
}

// The two hosts `GITHUB_FAKE_ORIGIN` stands in for; nothing else is ever rewritten.
const FAKEABLE_ORIGINS: ReadonlySet<string> = new Set(['https://github.com', 'https://api.github.com']);
const LOOPBACK_HOSTS: ReadonlySet<string> = new Set(['127.0.0.1', 'localhost', '[::1]']);

/**
 * Local runs only (`ENVIRONMENT=local`, like `GITHUB_MOCK`): `GITHUB_FAKE_ORIGIN` sends github.com and
 * api.github.com requests to a fake GitHub on this machine, as `<fake>/<host><path>`, so the owner flow can be run
 * end to end without GitHub. Only a loopback origin is accepted; anywhere else the variable is ignored.
 */
export function fakeGitHubFetch(env: ApiEnv, base: FetchLike): FetchLike {
  const configured = env.ENVIRONMENT === 'local' ? env.GITHUB_FAKE_ORIGIN?.trim() : undefined;
  if (configured === undefined || configured === '') {
    return base;
  }
  let fake: URL;
  try {
    fake = new URL(configured);
  } catch {
    throw ownerFlowMisconfigured('GITHUB_FAKE_ORIGIN must be a loopback http(s) origin');
  }
  if (!LOOPBACK_HOSTS.has(fake.hostname) || (fake.protocol !== 'http:' && fake.protocol !== 'https:')) {
    throw ownerFlowMisconfigured('GITHUB_FAKE_ORIGIN must be a loopback http(s) origin');
  }
  return async (input, init) => {
    const url = new URL(input);
    if (!FAKEABLE_ORIGINS.has(url.origin)) {
      throw new TypeError('the fake GitHub serves github.com and api.github.com only');
    }
    return base(`${fake.origin}/${url.host}${url.pathname}${url.search}`, init);
  };
}

/**
 * The api Worker's GitHub state for one isolate (created once in `createApiApp`): the app's installation-token
 * cache and the read cache. Mock mode (`GITHUB_MOCK=true`) is honoured only with `ENVIRONMENT=local`; on any
 * other environment the flag is ignored and the real app is used (#9 threat row 7).
 */
export class ApiGitHub {
  readonly readCache: ReadCache;
  private readonly fetcher: FetchLike;
  /** The clock of the owner flow (cookie age, expiries, `connected_at`): one source, so they agree. */
  readonly now: () => number;
  private readonly sleep: ((ms: number) => Promise<void>) | undefined;
  private real: { readonly appId: string; readonly pem: string; readonly auth: GitHubAppAuth } | undefined;
  private mock: Promise<GitHubConnection> | undefined;

  constructor(options: ApiGitHubOptions = {}) {
    // Wrapped: a Workers `fetch` stored on an object and called as its method throws "Illegal invocation".
    this.fetcher = options.fetch ?? (async (input, init) => fetch(input, init));
    this.readCache = options.readCache ?? new MemoryReadCache();
    this.now = options.now ?? (() => Date.now());
    this.sleep = options.sleep;
  }

  /** Waits `ms` (the sleep seam when a test set one). */
  async pause(ms: number): Promise<void> {
    if (this.sleep !== undefined) {
      await this.sleep(ms);
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, ms));
  }

  /** The app's OAuth side (owner connection, #59); 503 `github-auth` when the client id or secret is missing. */
  oauth(env: ApiEnv): GitHubOAuth {
    const credentials = {
      clientId: env.GITHUB_APP_CLIENT_ID?.trim() ?? '',
      clientSecret: env.GITHUB_APP_CLIENT_SECRET?.trim() ?? '',
    };
    if (!GitHubOAuth.isConfigured(credentials)) {
      throw ownerFlowMisconfigured(
        'GITHUB_APP_CLIENT_ID and GITHUB_APP_CLIENT_SECRET must be set on this Worker',
      );
    }
    return new GitHubOAuth(credentials, { fetch: fakeGitHubFetch(env, this.fetcher), now: this.now });
  }

  /** The one login the owner connection accepts; 503 `github-auth` when it is not set. */
  ownerLogin(env: ApiEnv): string {
    const login = env.OWNER_GITHUB_LOGIN?.trim() ?? '';
    if (!isGitHubLogin(login)) {
      throw ownerFlowMisconfigured(
        "OWNER_GITHUB_LOGIN must be set to the owner's GitHub login on this Worker",
      );
    }
    return login;
  }

  /** The environment's owner connection, the `OwnerTokenSource` of owner writes (#10). One per request. */
  async ownerConnection(env: ApiEnv, logger: Logger): Promise<OwnerConnection> {
    const oauth = this.oauth(env);
    return new OwnerConnection({
      environment: env.ENVIRONMENT,
      repo: new OwnerConnectionsRepo(env.DB),
      keys: await loadOwnerKeys(env.TOKEN_ENCRYPTION_KEY, env.ENVIRONMENT),
      oauth,
      logger,
      now: this.now,
      ...(this.sleep === undefined ? {} : { sleep: this.sleep }),
    });
  }

  /**
   * The transport of owner writes (#10): api.github.com, or on a local run with `GITHUB_FAKE_ORIGIN` the fake GitHub
   * that also holds the owner's tokens. Never the mock of `GITHUB_MOCK`, which knows installation tokens only.
   */
  ownerFetch(env: ApiEnv): FetchLike {
    return fakeGitHubFetch(env, this.fetcher);
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
