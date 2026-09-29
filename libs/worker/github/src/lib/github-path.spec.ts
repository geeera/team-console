import { githubPath } from './github-path';
import { parseRepoName } from './repo-name';

describe('githubPath', () => {
  it('encodes each repository segment and keeps the slash between them', () => {
    const repo = parseRepoName('geeera/team-console');
    expect(githubPath`/repos/${repo}/installation`).toBe('/repos/geeera/team-console/installation');
  });

  it('encodes string values so they cannot add segments or a query', () => {
    expect(githubPath`/repos/x/y/contents/${'../../app?x=1'}`).toBe(
      '/repos/x/y/contents/..%2F..%2Fapp%3Fx%3D1',
    );
  });

  it('allows non-negative integers and refuses anything else as a number', () => {
    expect(githubPath`/app/installations/${42}/access_tokens`).toBe('/app/installations/42/access_tokens');
    expect(() => githubPath`/app/installations/${-1}`).toThrow();
    expect(() => githubPath`/app/installations/${1.5}`).toThrow();
    expect(() => githubPath`/app/installations/${Number.NaN}`).toThrow();
  });

  it('requires an absolute path', () => {
    expect(() => githubPath`repos/${'x'}`).toThrow('a GitHub path starts with /');
  });
});
