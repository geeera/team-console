import { repositoryOf } from './records';

const RAW = { id: 42, full_name: 'geeera/team-console', default_branch: 'main', private: true };

describe('repositoryOf', () => {
  it('maps a repository answer, with the literal GitHub URL', () => {
    expect(repositoryOf(RAW)).toEqual({
      externalId: '42',
      fullName: 'geeera/team-console',
      defaultBranch: 'main',
      visibility: 'private',
      htmlUrl: 'https://github.com/geeera/team-console',
    });
  });

  it('reports a public repository', () => {
    expect(repositoryOf({ ...RAW, private: false })?.visibility).toBe('public');
  });

  it.each([
    ['not an object', 'nope'],
    ['no id', { ...RAW, id: undefined }],
    ['a malformed full name', { ...RAW, full_name: 'no-slash' }],
    ['no visibility flag', { ...RAW, private: 'yes' }],
  ])('is null for %s', (_label, raw) => {
    expect(repositoryOf(raw)).toBeNull();
  });
});
