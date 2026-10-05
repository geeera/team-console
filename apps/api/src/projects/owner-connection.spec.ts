import { env } from 'cloudflare:test';
import { createLogger } from '@worker/core';
import { MOCK_OWNER_ACCOUNT } from '@worker/github';
import { ApiGitHub } from '../github';
import { localEnv } from '../testing/github-kit';
import { fakeGitHub, parsedLogs, resetOwnerConnections, seedConnection } from '../testing/owner-kit';
import { connectedOwnerSource } from './owner-connection';

const PINNED = { login: 'geeera', id: 100001 };

function sourceWithLogs(): { source: ReturnType<typeof connectedOwnerSource>; logs: string[] } {
  return { source: connectedOwnerSource(new ApiGitHub({ fetch: fakeGitHub().fetch })), logs: [] };
}

describe('connectedOwnerSource (the registry over the #59 connection)', () => {
  beforeEach(async () => {
    await resetOwnerConnections();
  });

  it('is the connected login and the numeric id pinned at connect', async () => {
    await seedConnection(fakeGitHub(), { user: PINNED });
    const { source, logs } = sourceWithLogs();

    await expect(
      source.current(
        localEnv(),
        createLogger({}, (l) => logs.push(l)),
      ),
    ).resolves.toEqual({
      login: 'geeera',
      userId: 100001,
    });
  });

  it('is null without a connection, whatever OWNER_GITHUB_LOGIN says', async () => {
    const { source } = sourceWithLogs();
    await expect(
      source.current(
        localEnv({ OWNER_GITHUB_LOGIN: 'geeera' }),
        createLogger({}, () => undefined),
      ),
    ).resolves.toBeNull();
  });

  it('is null for an unusable row (the connection drops it and logs the signal)', async () => {
    await seedConnection(fakeGitHub(), { user: PINNED });
    await env.DB.prepare("UPDATE owner_connections SET key_id = '00000000'").run();
    const { source, logs } = sourceWithLogs();

    await expect(
      source.current(
        localEnv(),
        createLogger({}, (l) => logs.push(l)),
      ),
    ).resolves.toBeNull();
    expect(parsedLogs(logs)).toContainEqual(
      expect.objectContaining({ securitySignal: 'owner-not-connected' }),
    );
  });

  it('is null, with a warning, on a Worker without the connection configuration (fails closed, not 500)', async () => {
    await seedConnection(fakeGitHub(), { user: PINNED });
    const { source, logs } = sourceWithLogs();

    await expect(
      source.current(
        localEnv({ TOKEN_ENCRYPTION_KEY: '' }),
        createLogger({}, (l) => logs.push(l)),
      ),
    ).resolves.toBeNull();
    expect(parsedLogs(logs)).toContainEqual(
      expect.objectContaining({ message: 'owner connection not configured on this Worker' }),
    );
  });

  it('is the mock world owner only in local mock mode', async () => {
    const { source } = sourceWithLogs();
    const silent = createLogger({}, () => undefined);

    await expect(source.current(localEnv({ GITHUB_MOCK: 'true' }), silent)).resolves.toEqual(
      MOCK_OWNER_ACCOUNT,
    );
    await expect(
      source.current(localEnv({ ENVIRONMENT: 'dev', GITHUB_MOCK: 'true' }), silent),
    ).resolves.toBeNull();
  });
});
