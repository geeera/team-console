import type { GitHubConnectionDto } from '@shared/contracts';
import { UnsealError, openText, sealText, type Logger } from '@worker/core';
import type { OwnerConnectionRow, OwnerConnectionsRepo, SealedTokenPair } from '@worker/db';
import {
  GitHubError,
  ownerNotConnectedError,
  type GitHubOAuth,
  type GitHubUser,
  type OwnerAccount,
  type OwnerTokenSource,
  type UserTokenPair,
} from '@worker/github';
import { ownerFlowMisconfigured, type OwnerKeys } from './owner-keys';

/** Refresh when less than this is left (ADR 0003 decision 4). */
export const REFRESH_MARGIN_SECONDS = 30 * 60;
/** How long a refresh lease holds; a holder that died (transport, D1) blocks the others at most this long. */
export const LEASE_SECONDS = 60;
/** Waiters re-read at most this many times, this far apart, before giving up on the lease holder. */
export const LEASE_WAIT_ATTEMPTS = 5;
export const LEASE_WAIT_MS = 200;
// Every pass either returns, throws, waits (bounded above) or follows a version that moved; this caps the last.
const MAX_PASSES = LEASE_WAIT_ATTEMPTS + 4;

type TokenColumn = 'access_token_enc' | 'refresh_token_enc';

export type DisconnectOutcome =
  | { readonly kind: 'revoked' | 'not-connected' }
  | { readonly kind: 'grant-may-be-live'; readonly reason: 'no-usable-token' | 'token-rejected' };

export interface OwnerConnectionDeps {
  readonly environment: string;
  readonly repo: OwnerConnectionsRepo;
  readonly keys: OwnerKeys;
  readonly oauth: GitHubOAuth;
  readonly logger: Logger;
  /** Milliseconds since the epoch. */
  readonly now?: () => number;
  readonly sleep?: (ms: number) => Promise<void>;
}

/** A refresh error that names the grant or the refresh token: the chain is gone (decision 4). */
function namesTheGrant(error: string): boolean {
  return /refresh_token|grant/.test(error);
}

function refreshBusyError(): GitHubError {
  return new GitHubError(
    {
      type: 'github-unavailable',
      title: 'The GitHub connection is being refreshed',
      status: 503,
      detail: 'Another request is refreshing the owner token; try again in a moment',
      retryAfter: 1,
    },
    null,
  );
}

/**
 * The owner's connection in one environment (ADR 0003 decisions 3 and 4) and the `OwnerTokenSource` owner writes
 * use (#10, #17, #29). One instance per request: `invalidate` only affects the request that saw the 401.
 *
 * A row that cannot be used — unreadable ciphertext, a rotated master key, an expired or rejected refresh token — is
 * deleted and logged as a security signal (someone else may hold the chain; runbook: "Revoke all user tokens"),
 * and the caller gets 403 `github-owner-not-connected`, never a 500.
 */
export class OwnerConnection implements OwnerTokenSource {
  readonly kind = 'owner';
  private readonly environment: string;
  private readonly repo: OwnerConnectionsRepo;
  private readonly keys: OwnerKeys;
  private readonly oauth: GitHubOAuth;
  private readonly logger: Logger;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly invalidated = new Set<string>();

  constructor(deps: OwnerConnectionDeps) {
    this.environment = deps.environment;
    this.repo = deps.repo;
    this.keys = deps.keys;
    this.oauth = deps.oauth;
    this.logger = deps.logger;
    this.now = deps.now ?? (() => Date.now());
    this.sleep = deps.sleep ?? (async (ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  }

  /** What Settings shows (`GET /connection`); a row under a rotated key is dropped here too. Never a token. */
  async status(): Promise<GitHubConnectionDto> {
    const row = await this.repo.find(this.environment);
    if (row === null) {
      return { state: 'not-connected' };
    }
    if (row.key_id !== this.keys.keyId) {
      await this.forget(row, 'key-id-mismatch', this.keyIds(row));
      return { state: 'not-connected' };
    }
    return { state: 'connected', login: row.login, connectedAt: row.connected_at };
  }

  async account(): Promise<OwnerAccount> {
    const row = await this.load();
    return { login: row.login, userId: row.user_id };
  }

  invalidate(token: string): void {
    this.invalidated.add(token);
  }

  async getToken(): Promise<string> {
    let waits = 0;
    for (let pass = 0; pass < MAX_PASSES; pass += 1) {
      const row = await this.load();
      const nowSeconds = this.nowSeconds();
      const access = await this.open(row, 'access_token_enc');
      const isUsable = row.access_expires_at > nowSeconds && !this.invalidated.has(access);
      if (isUsable && row.access_expires_at - nowSeconds > REFRESH_MARGIN_SECONDS) {
        return access;
      }
      if (row.refresh_expires_at <= nowSeconds) {
        return this.drop(row, 'refresh-token-expired');
      }
      if (await this.repo.takeRefreshLease(this.environment, row.version, nowSeconds, LEASE_SECONDS)) {
        const refreshed = await this.refreshUnderLease(row);
        if (refreshed !== null) {
          return refreshed;
        }
        continue;
      }
      if (waits >= LEASE_WAIT_ATTEMPTS) {
        // The holder has not finished; a token that has not expired yet still works for this request.
        if (isUsable) {
          return access;
        }
        throw refreshBusyError();
      }
      waits += 1;
      await this.sleep(LEASE_WAIT_MS);
    }
    throw refreshBusyError();
  }

  /** Stores a fresh pair from the callback, replacing any previous connection of the environment. */
  async connect(user: GitHubUser, pair: UserTokenPair): Promise<void> {
    const previous = await this.repo.find(this.environment);
    if (previous !== null && previous.user_id !== user.id) {
      this.logger.warn('owner connection: the GitHub user id changed since the last connect', {
        securitySignal: 'owner-user-id-changed',
        login: user.login,
      });
    }
    await this.repo.connect({
      environment: this.environment,
      login: user.login,
      userId: user.id,
      now: new Date(this.now()).toISOString(),
      ...(await this.seal(pair)),
    });
  }

  /**
   * Disconnect (decision 3, threat row 11): the stored access token revokes the grant while it is still valid — no
   * refresh first, so a refused refresh cannot stand between us and the revoke (#87); only an expired one is
   * refreshed. Then the row goes. A GitHub failure throws and keeps the row, so the owner can retry. When no
   * usable token exists or GitHub rejects it, the row is gone but the grant may be live: `grant-may-be-live`, never
   * reported as a clean disconnect.
   */
  async disconnect(): Promise<DisconnectOutcome> {
    const row = await this.repo.find(this.environment);
    if (row === null) {
      return { kind: 'not-connected' };
    }
    const stored = await this.storedAccessToken(row);
    if (stored !== null) {
      return this.revokeAndForget(stored);
    }
    let token: string;
    try {
      token = await this.getToken();
    } catch (error: unknown) {
      if (error instanceof GitHubError && error.problem.type === 'github-owner-not-connected') {
        // getToken has deleted the unusable row and logged why; the grant was never revoked.
        return { kind: 'grant-may-be-live', reason: 'no-usable-token' };
      }
      throw error;
    }
    return this.revokeAndForget(token);
  }

  /** The stored access token when it decrypts under the current key and has not expired; otherwise `null`. */
  private async storedAccessToken(row: OwnerConnectionRow): Promise<string | null> {
    if (row.key_id !== this.keys.keyId || row.access_expires_at <= this.nowSeconds()) {
      return null;
    }
    try {
      return await openText(this.keys.tokenKey, row.access_token_enc, this.aad('access_token_enc'));
    } catch (error: unknown) {
      if (error instanceof UnsealError) {
        return null;
      }
      throw error;
    }
  }

  private async revokeAndForget(token: string): Promise<DisconnectOutcome> {
    const outcome = await this.oauth.revokeGrant(token);
    await this.repo.delete(this.environment);
    if (outcome === 'revoked') {
      return { kind: 'revoked' };
    }
    this.logSignal('revoke-token-rejected', {});
    return { kind: 'grant-may-be-live', reason: 'token-rejected' };
  }

  private nowSeconds(): number {
    return Math.floor(this.now() / 1000);
  }

  private aad(column: TokenColumn): string {
    return `${this.environment}:${column}`;
  }

  private async load(): Promise<OwnerConnectionRow> {
    const row = await this.repo.find(this.environment);
    if (row === null) {
      throw ownerNotConnectedError();
    }
    if (row.key_id !== this.keys.keyId) {
      return this.drop(row, 'key-id-mismatch', this.keyIds(row));
    }
    return row;
  }

  private async open(row: OwnerConnectionRow, column: TokenColumn): Promise<string> {
    try {
      return await openText(this.keys.tokenKey, row[column], this.aad(column));
    } catch (error: unknown) {
      if (error instanceof UnsealError) {
        return this.drop(row, 'decrypt-failed', { column });
      }
      throw error;
    }
  }

  private async seal(pair: UserTokenPair): Promise<SealedTokenPair> {
    return {
      accessTokenEnc: await sealText(this.keys.tokenKey, pair.accessToken, this.aad('access_token_enc')),
      refreshTokenEnc: await sealText(this.keys.tokenKey, pair.refreshToken, this.aad('refresh_token_enc')),
      accessExpiresAt: pair.accessExpiresAt,
      refreshExpiresAt: pair.refreshExpiresAt,
      keyId: this.keys.keyId,
    };
  }

  /**
   * Only the lease holder gets here. A new pair → stored over `version` and returned. A refusal that names the
   * grant → the row is deleted at `version` (403), or, when the version moved meanwhile (another isolate
   * refreshed after our lease expired), `null` so the caller re-reads. Transport, 5xx and D1 failures throw and
   * leave the lease to expire, so the next caller retries from the stored pair.
   */
  private async refreshUnderLease(row: OwnerConnectionRow): Promise<string | null> {
    const refreshToken = await this.open(row, 'refresh_token_enc');
    const result = await this.oauth.refresh(refreshToken);
    if (result.kind === 'issued') {
      const stored = await this.repo.storeRefreshed(
        this.environment,
        row.version,
        await this.seal(result.pair),
        new Date(this.now()).toISOString(),
      );
      if (!stored) {
        this.logger.warn(
          'owner token refreshed but the row moved on; the new pair serves this request only',
          {
            version: row.version,
          },
        );
      }
      return result.pair.accessToken;
    }
    if (result.kind === 'refused' && namesTheGrant(result.error)) {
      if (await this.repo.deleteAtVersion(this.environment, row.version)) {
        this.logSignal('refresh-refused', { error: result.error });
        throw ownerNotConnectedError();
      }
      return null;
    }
    const reason = result.kind === 'refused' ? result.error : 'non-expiring-token';
    this.logger.error('owner token refresh refused', { reason });
    throw ownerFlowMisconfigured('GitHub refused to refresh the owner token with this app configuration');
  }

  private keyIds(row: OwnerConnectionRow): Record<string, string> {
    return { storedKeyId: row.key_id, expectedKeyId: this.keys.keyId };
  }

  /** Deletes an unusable row (at its version); the log line is the security signal. */
  private async forget(
    row: OwnerConnectionRow,
    reason: string,
    fields: Record<string, string>,
  ): Promise<void> {
    await this.repo.deleteAtVersion(this.environment, row.version);
    this.logSignal(reason, fields);
  }

  /** `forget`, then 403 `github-owner-not-connected`. */
  private async drop(
    row: OwnerConnectionRow,
    reason: string,
    fields: Record<string, string> = {},
  ): Promise<never> {
    await this.forget(row, reason, fields);
    throw ownerNotConnectedError();
  }

  private logSignal(reason: string, fields: Record<string, string>): void {
    this.logger.warn('owner connection lost', {
      securitySignal: 'owner-not-connected',
      reason,
      ...fields,
      runbook: 'ADR 0003 decision 7: if unexpected, revoke all user tokens of the app and connect again',
    });
  }
}
