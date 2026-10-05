import { InvalidRepoNameError, isValidRepoName, parseRepoName, sameRepo } from './repo-name';

describe('parseRepoName', () => {
  it.each(['geeera/team-console', 'Acme-1/app.web', 'a/b_c', 'x/.github', 'x/..hidden', 'x/a..b'])(
    'accepts %s',
    (value) => {
      const repo = parseRepoName(value);
      expect(repo.fullName).toBe(value);
      expect(`${repo.owner}/${repo.name}`).toBe(value);
    },
  );

  it.each([
    ['empty', ''],
    ['no slash', 'geeera'],
    ['three segments', 'geeera/team-console/issues'],
    ['a dot segment', 'geeera/.'],
    ['a dot-dot segment', 'geeera/..'],
    ['dot-dot owner', '../team-console'],
    ['a path back to /app (JWT target)', '../../app/installations/1/access_tokens'],
    ['an encoded slash', 'geeera%2F..%2Fapp/x'],
    ['a query', 'geeera/team-console?per_page=100'],
    ['a fragment', 'geeera/team-console#x'],
    ['whitespace', 'geeera/team console'],
    ['a leading slash', '/geeera/team-console'],
    ['an underscore owner', 'gee_era/x'],
    ['non-ASCII', 'geeera/tеam'],
    ['an over-long owner', `${'a'.repeat(40)}/x`],
    ['an over-long name', `a/${'b'.repeat(101)}`],
  ])('rejects %s', (_label, value) => {
    expect(() => parseRepoName(value)).toThrow(InvalidRepoNameError);
    expect(isValidRepoName(value)).toBe(false);
  });

  it('never echoes the rejected input', () => {
    const hostile = '<script>/x';
    expect(() => parseRepoName(hostile)).toThrow(/^not a valid owner\/name repository$/);
  });
});

describe('sameRepo', () => {
  it('compares case-insensitively like GitHub', () => {
    expect(sameRepo(parseRepoName('Geeera/Team-Console'), parseRepoName('geeera/team-console'))).toBe(true);
    expect(sameRepo(parseRepoName('geeera/a'), parseRepoName('geeera/b'))).toBe(false);
  });
});
