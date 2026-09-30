import { GitHubError, type FetchLike } from '@worker/github';
import { fakeGitHubFetch } from './github';
import { localEnv } from './testing/github-kit';

function recording(): { fetch: FetchLike; urls: string[] } {
  const urls: string[] = [];
  return {
    urls,
    fetch: async (input) => {
      urls.push(input);
      return new Response(null, { status: 204 });
    },
  };
}

describe('fakeGitHubFetch (GITHUB_FAKE_ORIGIN, local runs only)', () => {
  it('is the real fetch when the variable is not set', () => {
    const base = recording();
    expect(fakeGitHubFetch(localEnv(), base.fetch)).toBe(base.fetch);
  });

  it('is ignored outside ENVIRONMENT=local', () => {
    const base = recording();
    const env = localEnv({ ENVIRONMENT: 'dev', GITHUB_FAKE_ORIGIN: 'http://127.0.0.1:9999' });
    expect(fakeGitHubFetch(env, base.fetch)).toBe(base.fetch);
  });

  it('sends github.com and api.github.com to the fake as /<host><path>', async () => {
    const base = recording();
    const fetch = fakeGitHubFetch(localEnv({ GITHUB_FAKE_ORIGIN: 'http://127.0.0.1:9999' }), base.fetch);

    await fetch('https://github.com/login/oauth/access_token', { method: 'POST' });
    await fetch('https://api.github.com/user?x=1', {});

    expect(base.urls).toEqual([
      'http://127.0.0.1:9999/github.com/login/oauth/access_token',
      'http://127.0.0.1:9999/api.github.com/user?x=1',
    ]);
    await expect(fetch('https://evil.example/', {})).rejects.toThrow(TypeError);
  });

  it.each(['http://192.168.1.10:9999', 'https://fake.example', 'not a url', 'file:///etc/passwd'])(
    'refuses a non-loopback origin %s with 503 github-auth',
    (origin) => {
      expect(() => fakeGitHubFetch(localEnv({ GITHUB_FAKE_ORIGIN: origin }), recording().fetch)).toThrow(
        GitHubError,
      );
    },
  );
});
