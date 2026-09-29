import { env } from 'cloudflare:test';
import { createLogger } from '@worker/core';
import { OwnerConnectionsRepo, type OwnerConnectionRow } from '@worker/db';
import { GitHubOAuth } from '@worker/github';
import { OwnerConnection } from '../owner/owner-connection';
import { loadOwnerKeys } from '../owner/owner-keys';
import { FakeGitHubOAuth, type FakeGitHubOAuthOptions, type FakeUser } from './fake-github-oauth';

/** Test-only helpers around the owner connection (#59), on the pool's bindings and the fake GitHub. */

export const OWNER: FakeUser = { login: 'geeera', id: 1001 };
export const ENVIRONMENT = 'local';

export function fakeGitHub(options: Partial<FakeGitHubOAuthOptions> = {}): FakeGitHubOAuth {
  return new FakeGitHubOAuth({
    clientId: env.GITHUB_APP_CLIENT_ID,
    clientSecret: env.GITHUB_APP_CLIENT_SECRET ?? '',
    ...options,
  });
}

export async function resetOwnerConnections(): Promise<void> {
  await env.DB.prepare('DELETE FROM owner_connections').run();
}

export async function storedRow(): Promise<OwnerConnectionRow | null> {
  return new OwnerConnectionsRepo(env.DB).find(ENVIRONMENT);
}

export interface ConnectionOptions {
  readonly now?: () => number;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly repo?: OwnerConnectionsRepo;
  readonly logs?: string[];
  readonly masterKey?: string;
}

export async function ownerConnection(
  fake: FakeGitHubOAuth,
  options: ConnectionOptions = {},
): Promise<OwnerConnection> {
  const now = options.now ?? (() => Date.now());
  return new OwnerConnection({
    environment: ENVIRONMENT,
    repo: options.repo ?? new OwnerConnectionsRepo(env.DB),
    keys: await loadOwnerKeys(options.masterKey ?? env.TOKEN_ENCRYPTION_KEY, ENVIRONMENT),
    oauth: new GitHubOAuth(
      { clientId: env.GITHUB_APP_CLIENT_ID, clientSecret: env.GITHUB_APP_CLIENT_SECRET ?? '' },
      { fetch: fake.fetch, now },
    ),
    logger: createLogger({ service: 'test' }, (line) => options.logs?.push(line)),
    now,
    ...(options.sleep === undefined ? {} : { sleep: options.sleep }),
  });
}

/** Stores a connection whose access token has `accessSecondsLeft` to live at `nowMs`. */
export async function seedConnection(
  fake: FakeGitHubOAuth,
  options: { accessSecondsLeft?: number; refreshSecondsLeft?: number; nowMs?: number } = {},
): Promise<{ accessToken: string; refreshToken: string }> {
  const nowMs = options.nowMs ?? Date.now();
  const nowSeconds = Math.floor(nowMs / 1000);
  const pair = fake.issuePair(OWNER);
  const connection = await ownerConnection(fake, { now: () => nowMs });
  await connection.connect(OWNER, {
    ...pair,
    accessExpiresAt: nowSeconds + (options.accessSecondsLeft ?? 8 * 60 * 60),
    refreshExpiresAt: nowSeconds + (options.refreshSecondsLeft ?? 180 * 24 * 60 * 60),
  });
  return pair;
}

export function parsedLogs(lines: readonly string[]): Record<string, unknown>[] {
  return lines.map((line) => JSON.parse(line) as Record<string, unknown>);
}
