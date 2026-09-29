import { localEnv } from '../testing/github-kit';
import { configuredOwnerConnection, isConnectedOwner } from './owner-connection';

describe('configuredOwnerConnection (until #59)', () => {
  it('is the OWNER_GITHUB_LOGIN var, without a pinned id', async () => {
    await expect(
      configuredOwnerConnection.current(localEnv({ OWNER_GITHUB_LOGIN: ' geeera ' })),
    ).resolves.toEqual({
      login: 'geeera',
      userId: null,
    });
  });

  it.each(['', '   ', '-geeera', 'gee--era', 'a/b', 'geeera?x', 'a'.repeat(40)])(
    'counts %j as not connected',
    async (login) => {
      await expect(
        configuredOwnerConnection.current(localEnv({ OWNER_GITHUB_LOGIN: login })),
      ).resolves.toBeNull();
    },
  );
});

describe('isConnectedOwner', () => {
  const owner = { login: 'Geeera', id: 100001 };

  it('compares the login case-insensitively', () => {
    expect(isConnectedOwner(owner, { login: 'geeera', userId: null })).toBe(true);
    expect(isConnectedOwner(owner, { login: 'acme', userId: null })).toBe(false);
  });

  it('also compares the id once one is pinned', () => {
    expect(isConnectedOwner(owner, { login: 'geeera', userId: 100001 })).toBe(true);
    expect(isConnectedOwner(owner, { login: 'geeera', userId: 5 })).toBe(false);
  });
});
