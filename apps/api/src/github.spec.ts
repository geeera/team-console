import { GitHubError, type FetchLike } from '@worker/github';
import { fakeGitHubFetch, localIssueThreads } from './github';
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

describe('localIssueThreads (GITHUB_MOCK + GITHUB_FAKE_ORIGIN, #114)', () => {
  const THREAD = 'https://api.github.com/repos/geeera/team-console/issues/22/comments';
  const answer = (status: number, body: unknown): Response => Response.json(body, { status });

  it('is the mock alone without a fake origin, and outside ENVIRONMENT=local', () => {
    const mock: FetchLike = async () => answer(200, []);
    expect(localIssueThreads(localEnv(), mock, recording().fetch)).toBe(mock);
    const dev = localEnv({ ENVIRONMENT: 'dev', GITHUB_FAKE_ORIGIN: 'http://127.0.0.1:9999' });
    expect(localIssueThreads(dev, mock, recording().fetch)).toBe(mock);
  });

  it('reads a thread the fake serves after the mock accepted the token; otherwise keeps the mock answer', async () => {
    const env = localEnv({ GITHUB_FAKE_ORIGIN: 'http://127.0.0.1:9999' });
    const seen: string[] = [];
    const fake: FetchLike = async (input) => {
      seen.push(input);
      return input.includes('/issues/22') ? answer(200, [{ id: 1 }]) : answer(404, {});
    };
    const mock: FetchLike = async (input) =>
      input.includes('/issues/401') ? answer(401, { message: 'Bad credentials' }) : answer(200, []);
    const fetch = localIssueThreads(env, mock, fake);

    await expect((await fetch(THREAD, {})).json()).resolves.toEqual([{ id: 1 }]);
    expect(seen).toEqual([
      'http://127.0.0.1:9999/api.github.com/repos/geeera/team-console/issues/22/comments',
    ]);
    await expect((await fetch(THREAD.replace('/22/', '/7/'), {})).json()).resolves.toEqual([]);
    expect((await fetch(THREAD.replace('/22/', '/401/'), {})).status).toBe(401);
    expect(seen).toHaveLength(2);
    await fetch('https://api.github.com/repos/geeera/team-console', {});
    expect(seen).toHaveLength(2);
  });

  it('reads the milestone list from the fake once it serves the repository (#218)', async () => {
    const env = localEnv({ GITHUB_FAKE_ORIGIN: 'http://127.0.0.1:9999' });
    const fake: FetchLike = async (input) =>
      input.includes('geeera/team-console') ? answer(200, [{ number: 4 }]) : answer(404, {});
    const mock: FetchLike = async () => answer(200, [{ number: 1 }]);
    const fetch = localIssueThreads(env, mock, fake);

    const served = await fetch('https://api.github.com/repos/geeera/team-console/milestones?state=all', {});
    await expect(served.json()).resolves.toEqual([{ number: 4 }]);
    const other = await fetch('https://api.github.com/repos/geeera/fieldnote/milestones?state=all', {});
    await expect(other.json()).resolves.toEqual([{ number: 1 }]);
  });
});
