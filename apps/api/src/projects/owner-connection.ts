import type { ApiEnv } from '../env';

/** The GitHub account projects must belong to (ADR 0003 decision 2). */
export interface OwnerConnection {
  readonly login: string;
  /** The numeric user id pinned at connect; `null` while only the login is known (before #59). */
  readonly userId: number | null;
}

/**
 * Where the registry learns the connected owner account. #59 replaces the configured source with the OAuth
 * connection (`owner_connections`, login and user id pinned at connect) without touching the registry.
 */
export interface OwnerConnectionSource {
  /** `null` when no account is connected: adding answers 403 `github-owner-not-connected`. */
  current(env: ApiEnv): Promise<OwnerConnection | null>;
}

// GitHub logins: alphanumerics and single hyphens, not at either end, at most 39 characters.
const GITHUB_LOGIN = /^[A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38}$/;

/**
 * Until #59: the owner is the `OWNER_GITHUB_LOGIN` var (ADR 0003 decision 7), compared by login only. An empty
 * or malformed value counts as "not connected", so a misconfigured Worker refuses instead of accepting anyone.
 */
export const configuredOwnerConnection: OwnerConnectionSource = {
  current: async (env) => {
    const login = (env.OWNER_GITHUB_LOGIN ?? '').trim();
    return GITHUB_LOGIN.test(login) ? { login, userId: null } : null;
  },
};

/** The console route that starts the owner connection (#59); the 403 problem carries it as `connectUrl`. */
export const CONNECT_URL = '/api/v1/github/connect';

export interface RepositoryOwner {
  readonly login: string;
  readonly id: number;
}

/** Decision 2(b): the login case-insensitively and, once pinned, the numeric id. */
export function isConnectedOwner(owner: RepositoryOwner, connection: OwnerConnection): boolean {
  if (owner.login.toLowerCase() !== connection.login.toLowerCase()) {
    return false;
  }
  return connection.userId === null || connection.userId === owner.id;
}
