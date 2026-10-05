import { json, scriptedGitHub } from '../testing/github-kit';
import { GitHubError, requestBudgetError } from './errors';
import { githubPath } from './github-path';
import { githubRequest, onGitHubApi } from './transport';

const BEARER = ['ghs', 'TESTSENTINEL'].join('_');

async function problemOf(promise: Promise<unknown>): Promise<GitHubError> {
  try {
    await promise;
  } catch (error: unknown) {
    if (error instanceof GitHubError) {
      return error;
    }
    throw error;
  }
  throw new Error('expected a GitHubError');
}

describe('githubRequest', () => {
  it('sends GitHub headers, the bearer and redirect: manual to api.github.com', async () => {
    const github = scriptedGitHub(() => json(200, {}));
    await githubRequest(github.fetch, {
      method: 'GET',
      path: githubPath`/repos/${'a'}/${'b'}`,
      bearer: BEARER,
    });

    const [call] = github.calls;
    expect(call?.url).toBe('https://api.github.com/repos/a/b');
    expect(call?.redirect).toBe('manual');
    expect(call?.headers.get('authorization')).toBe(`Bearer ${BEARER}`);
    expect(call?.headers.get('accept')).toBe('application/vnd.github+json');
    expect(call?.headers.get('x-github-api-version')).toBe('2022-11-28');
    expect(call?.headers.get('user-agent')).toBe('team-console');
  });

  it('sends a JSON body on POST', async () => {
    const github = scriptedGitHub(() => json(201, {}));
    await githubRequest(github.fetch, {
      method: 'POST',
      path: githubPath`/x`,
      bearer: BEARER,
      body: { a: 1 },
    });
    expect(github.calls[0]?.body).toBe('{"a":1}');
    expect(github.calls[0]?.headers.get('content-type')).toBe('application/json');
  });

  it('sends Basic client credentials and a JSON body on DELETE', async () => {
    const github = scriptedGitHub(() => new Response(null, { status: 204 }));
    await githubRequest(github.fetch, {
      method: 'DELETE',
      path: githubPath`/applications/${'Iv23abc'}/grant`,
      basic: { clientId: 'Iv23abc', clientSecret: 'shh' },
      body: { access_token: 'x' },
    });
    const [call] = github.calls;
    expect(call?.method).toBe('DELETE');
    expect(call?.headers.get('authorization')).toBe(`Basic ${btoa('Iv23abc:shh')}`);
    expect(call?.body).toBe('{"access_token":"x"}');
  });

  it('gives every request a deadline, and a request that hits it is 502 github-unavailable', async () => {
    const github = scriptedGitHub(() => json(200, {}));
    await githubRequest(github.fetch, { method: 'GET', path: githubPath`/x`, bearer: BEARER });
    expect(github.calls[0]?.signal).toBeInstanceOf(AbortSignal);

    const timedOut = scriptedGitHub(() => {
      throw new DOMException('The operation was aborted due to timeout', 'TimeoutError');
    });
    const error = await problemOf(
      githubRequest(timedOut.fetch, { method: 'GET', path: githubPath`/x`, bearer: BEARER }),
    );
    expect(error.problem).toMatchObject({ type: 'github-unavailable', status: 502 });
  });

  it.each([301, 302, 303, 307, 308])(
    'a %i off api.github.com → 502 github-unexpected and no request reaches the other host (row 1)',
    async (status) => {
      const github = scriptedGitHub(
        () => new Response(null, { status, headers: { location: 'https://evil.example/x' } }),
      );
      const error = await problemOf(
        githubRequest(github.fetch, { method: 'GET', path: githubPath`/repos/a/b`, bearer: BEARER }),
      );
      expect(error.problem).toMatchObject({ type: 'github-unexpected', status: 502 });
      expect(github.calls.map((call) => new URL(call.url).host)).toEqual(['api.github.com']);
    },
  );

  it.each([
    ['http downgrade', 'http://api.github.com/repos/a/c'],
    ['another port', 'https://api.github.com:8443/repos/a/c'],
    ['userinfo', 'https://user@api.github.com/repos/a/c'],
    ['a look-alike host', 'https://api.github.com.evil.example/repos/a/c'],
    ['protocol-relative', '//evil.example/x'],
  ])('refuses a redirect to %s', async (_label, location) => {
    const github = scriptedGitHub(() => new Response(null, { status: 301, headers: { location } }));
    const error = await problemOf(
      githubRequest(github.fetch, { method: 'GET', path: githubPath`/repos/a/b`, bearer: BEARER }),
    );
    expect(error.problem.type).toBe('github-unexpected');
    expect(github.calls).toHaveLength(1);
  });

  it('follows a redirect that stays on api.github.com (renamed repository)', async () => {
    const github = scriptedGitHub((call) =>
      call.url.endsWith('/repos/a/old')
        ? new Response(null, { status: 301, headers: { location: '/repositories/77' } })
        : json(200, { ok: true }),
    );
    const response = await githubRequest(github.fetch, {
      method: 'GET',
      path: githubPath`/repos/a/old`,
      bearer: BEARER,
    });
    expect(response.status).toBe(200);
    expect(github.calls.map((call) => call.url)).toEqual([
      'https://api.github.com/repos/a/old',
      'https://api.github.com/repositories/77',
    ]);
  });

  it('never follows a redirect of a POST', async () => {
    const github = scriptedGitHub(
      () => new Response(null, { status: 307, headers: { location: 'https://api.github.com/other' } }),
    );
    const error = await problemOf(
      githubRequest(github.fetch, { method: 'POST', path: githubPath`/x`, bearer: BEARER, body: {} }),
    );
    expect(error.problem.type).toBe('github-unexpected');
    expect(github.calls).toHaveLength(1);
  });

  it('stops after three hops', async () => {
    const github = scriptedGitHub(
      () => new Response(null, { status: 302, headers: { location: 'https://api.github.com/loop' } }),
    );
    const error = await problemOf(
      githubRequest(github.fetch, { method: 'GET', path: githubPath`/loop`, bearer: BEARER }),
    );
    expect(error.problem.type).toBe('github-unexpected');
    expect(github.calls).toHaveLength(3);
  });

  it('turns a network failure into 502 github-unavailable without the thrown message', async () => {
    const github = scriptedGitHub(() => {
      throw new TypeError(`connect failed; Authorization: Bearer ${BEARER}`);
    });
    const error = await problemOf(
      githubRequest(github.fetch, { method: 'GET', path: githubPath`/x`, bearer: BEARER }),
    );
    expect(error.problem).toMatchObject({ type: 'github-unavailable', status: 502 });
    expect(error.githubStatus).toBeNull();
    expect(JSON.stringify({ ...error, message: error.message, stack: error.stack })).not.toContain(BEARER);
  });

  it('passes on a GitHub problem the transport raised before sending (a request budget)', async () => {
    const github = scriptedGitHub(() => {
      throw requestBudgetError();
    });
    const error = await problemOf(
      githubRequest(github.fetch, { method: 'GET', path: githubPath`/x`, bearer: BEARER }),
    );
    expect(error.problem.type).toBe('github-request-budget');
  });
});

describe('onGitHubApi', () => {
  it('accepts only https://api.github.com', () => {
    expect(onGitHubApi('https://api.github.com/x?page=2')?.pathname).toBe('/x');
    expect(onGitHubApi('https://uploads.github.com/x')).toBeNull();
    expect(onGitHubApi('not a url')).toBeNull();
  });
});
