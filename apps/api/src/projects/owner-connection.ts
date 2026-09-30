import type { Logger } from '@worker/core';
import { GitHubError, MOCK_OWNER_ACCOUNT, isGitHubMockEnabled, type OwnerAccount } from '@worker/github';
import type { ApiEnv } from '../env';
import type { ApiGitHub } from '../github';

/**
 * Where the registry learns the connected owner account (ADR 0003 decision 2(b)): the login and the numeric id
 * pinned at connect. A seam so registry specs can pin an account without running the OAuth flow.
 */
export interface OwnerConnectionSource {
  /** `null` when no account is connected: adding answers 403 `github-owner-not-connected`. */
  current(env: ApiEnv, logger: Logger): Promise<OwnerAccount | null>;
}

/**
 * The registry's owner is the #59 connection (`ApiGitHub.ownerConnection(...).account()`). No connection, an
 * unusable row (dropped and logged by the connection itself) or a Worker without the connection's configuration
 * all count as "not connected", so the registry refuses rather than accepting anyone. With `GITHUB_MOCK=true`
 * (local only) the mock world's owner is connected: mock mode has no OAuth to connect with.
 */
export function connectedOwnerSource(github: ApiGitHub): OwnerConnectionSource {
  return {
    current: async (env, logger) => {
      if (isGitHubMockEnabled(env)) {
        return MOCK_OWNER_ACCOUNT;
      }
      try {
        const connection = await github.ownerConnection(env, logger);
        return await connection.account();
      } catch (error: unknown) {
        if (!(error instanceof GitHubError)) {
          throw error;
        }
        if (error.problem.type === 'github-owner-not-connected') {
          return null;
        }
        if (error.problem.type === 'github-auth') {
          logger.warn('owner connection not configured on this Worker', { detail: error.problem.detail });
          return null;
        }
        throw error;
      }
    },
  };
}
