import { isGitHubAuthorizeUrl, isGitHubLogin, isGitHubPageUrl } from './github-urls';

describe('isGitHubAuthorizeUrl', () => {
  it.each([
    'https://github.com/login/oauth/authorize?client_id=Iv23&state=ab&code_challenge=x&code_challenge_method=S256',
    'https://github.com/login/oauth/authorize',
    'https://GITHUB.com/login/oauth/authorize?x=1',
    'https://github.com:443/login/oauth/authorize',
  ])('accepts %s', (url) => {
    expect(isGitHubAuthorizeUrl(url)).toBe(true);
  });

  it.each([
    ['another host with the prefix', 'https://github.com.evil.example/login/oauth/authorize'],
    ['credentials before the host', 'https://github.com@evil.example/login/oauth/authorize'],
    ['user info on github.com', 'https://user:pw@github.com/login/oauth/authorize'],
    ['plain http', 'http://github.com/login/oauth/authorize'],
    ['another port', 'https://github.com:8443/login/oauth/authorize'],
    ['a subdomain', 'https://gist.github.com/login/oauth/authorize'],
    ['a longer path', 'https://github.com/login/oauth/authorize/extra'],
    ['a path that only normalises to it', 'https://github.com/login/oauth/x/../authorize2'],
    ['another GitHub page', 'https://github.com/login/oauth/access_token'],
    ['a relative path', '/login/oauth/authorize'],
    ['javascript', 'javascript:alert(1)'],
    ['the fake GitHub', 'http://127.0.0.1:9999/github.com/login/oauth/authorize'],
    ['an empty string', ''],
    ['not a string', 42],
    ['missing', undefined],
  ])('refuses %s', (_label, url) => {
    expect(isGitHubAuthorizeUrl(url)).toBe(false);
  });

  it('accepts a dot-segment path only when it resolves to the authorize path exactly', () => {
    expect(isGitHubAuthorizeUrl('https://github.com/login/x/../oauth/authorize')).toBe(true);
  });
});

describe('isGitHubPageUrl', () => {
  it('accepts https pages on github.com and nothing else', () => {
    expect(isGitHubPageUrl('https://github.com/settings/applications')).toBe(true);
    expect(isGitHubPageUrl('https://github.com/apps/team-console-dev/installations/new')).toBe(true);
    expect(isGitHubPageUrl('http://github.com/settings/applications')).toBe(false);
    expect(isGitHubPageUrl('https://evil.example/settings/applications')).toBe(false);
    expect(isGitHubPageUrl('javascript:alert(1)')).toBe(false);
  });
});

describe('isGitHubLogin', () => {
  it.each(['geeera', 'a', 'acme-corp', 'A1', 'x'.repeat(39)])('accepts %s', (login) => {
    expect(isGitHubLogin(login)).toBe(true);
  });

  it.each(['', '-a', 'a-', 'a b', 'a/b', 'x'.repeat(40), '<script>', 7])('refuses %j', (login) => {
    expect(isGitHubLogin(login)).toBe(false);
  });
});
