import { isRepoFullName, repoFullNameParts } from './repo-name';

describe('repoFullNameParts', () => {
  it('splits a GitHub owner/name', () => {
    expect(repoFullNameParts('geeera/team-console')).toEqual({ owner: 'geeera', name: 'team-console' });
    expect(repoFullNameParts('a-b/c.d_e')).toEqual({ owner: 'a-b', name: 'c.d_e' });
  });

  it.each([
    '',
    'geeera',
    'geeera/',
    '/repo',
    'geeera/team/console',
    'geeera/..',
    'geeera/.',
    'gee era/repo',
    'geeera/re%2fpo',
    'geeera/repo?x=1',
    `${'a'.repeat(40)}/repo`,
    `geeera/${'r'.repeat(101)}`,
  ])('refuses %j', (value) => {
    expect(repoFullNameParts(value)).toBeNull();
    expect(isRepoFullName(value)).toBe(false);
  });

  it('refuses a value that is not a string', () => {
    expect(isRepoFullName(42)).toBe(false);
    expect(isRepoFullName(null)).toBe(false);
  });
});
