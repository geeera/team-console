import { GitHubError } from './errors';
import { assertRepoOwnedBy, isRepoOwnedBy } from './owner-check';

const ACCOUNT = { login: 'geeera', userId: 1001 };

describe('assertRepoOwnedBy', () => {
  it('isRepoOwnedBy needs both the login (any case) and the pinned id', () => {
    expect(isRepoOwnedBy(ACCOUNT, { login: 'GEEERA', id: 1001 })).toBe(true);
    expect(isRepoOwnedBy(ACCOUNT, { login: 'geeera', id: 1002 })).toBe(false);
    expect(isRepoOwnedBy(ACCOUNT, { login: 'acme', id: 1001 })).toBe(false);
  });

  it('passes for the connected account, whatever the login casing', () => {
    expect(() => assertRepoOwnedBy(ACCOUNT, { login: 'Geeera', id: 1001 }, 'geeera/app')).not.toThrow();
  });

  it.each([
    ['another login', { login: 'acme', id: 1001 }],
    ['the same login with another id (renamed or re-registered)', { login: 'geeera', id: 2002 }],
  ])('refuses %s with 409 github-owner-mismatch', (_label, owner) => {
    try {
      assertRepoOwnedBy(ACCOUNT, owner, 'x/app');
      throw new Error('expected a mismatch');
    } catch (error: unknown) {
      expect(error).toBeInstanceOf(GitHubError);
      expect((error as GitHubError).problem).toMatchObject({ type: 'github-owner-mismatch', status: 409 });
    }
  });
});
