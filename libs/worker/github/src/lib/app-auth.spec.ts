import {
  INSTALLATION_ID,
  SENTINEL_TOKEN,
  appFlow,
  decodeJwt,
  generateAppKey,
  json,
  mintScopeOf,
  scriptedGitHub,
  type AppKey,
} from '../testing/github-kit';
import { GitHubAppAuth, INSTALLATION_PERMISSIONS, createAppJwt, importAppPrivateKey } from './app-auth';
import { GitHubError } from './errors';
import { parseRepoName } from './repo-name';

const APP_ID = '123456';
const REPO = parseRepoName('geeera/team-console');
const NOW = Date.parse('2026-09-30T12:00:00Z');

// Assembled at run time so the repository's secret scanners never see a key-shaped literal.
const PKCS8_LABEL = `${'PRIVATE'} KEY`;
const armored = (label: string, body: string) => `-----BEGIN ${label}-----\n${body}\n-----END ${label}-----`;

let key: AppKey;

beforeAll(async () => {
  key = await generateAppKey();
});

async function rejection(promise: Promise<unknown>): Promise<GitHubError> {
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

function notCalled() {
  return scriptedGitHub(() => {
    throw new Error('no request may be made');
  });
}

describe('createAppJwt', () => {
  it('signs RS256 with iat = now − 60 s, exp = now + 9 min, iss = the app id', async () => {
    const signingKey = await importAppPrivateKey(key.pem);
    const jwt = await createAppJwt(signingKey, APP_ID, NOW);
    const decoded = await decodeJwt(jwt, key.publicKey);

    const now = NOW / 1000;
    expect(decoded.signatureValid).toBe(true);
    expect(decoded.header).toEqual({ alg: 'RS256', typ: 'JWT' });
    expect(decoded.claims).toEqual({ iat: now - 60, exp: now + 540, iss: APP_ID });
  });
});

describe('importAppPrivateKey (PKCS#8 only, ADR 0003 decision 6)', () => {
  it('accepts a PKCS#8 PEM, with CRLF line ends and surrounding whitespace', async () => {
    await expect(importAppPrivateKey(`\n  ${key.pem.replace(/\n/g, '\r\n')}  \n`)).resolves.toBeDefined();
  });

  it.each([
    [
      'a PKCS#1 key',
      (key) =>
        key.pem
          .replace(/BEGIN PRIVATE KEY/, 'BEGIN RSA PRIVATE KEY')
          .replace(/END PRIVATE KEY/, 'END RSA PRIVATE KEY'),
    ],
    ['an encrypted key', (key) => key.pem.replace(/PRIVATE KEY/g, 'ENCRYPTED PRIVATE KEY')],
    ['a public key', () => armored('PUBLIC KEY', 'MIIB')],
    ['an empty value', () => ''],
    ['base64 of the PEM', (key) => btoa(key.pem)],
    ['broken base64', () => armored(PKCS8_LABEL, '@@@@')],
    ['DER that is not a key', () => armored(PKCS8_LABEL, 'AAAA')],
  ] as const satisfies readonly (readonly [string, (key: AppKey) => string])[])(
    'refuses %s with 503 github-auth and says nothing of the key',
    async (_label, pemOf) => {
      const error = await rejection(importAppPrivateKey(pemOf(key)));
      expect(error.problem).toMatchObject({ type: 'github-auth', status: 503 });
      expect(JSON.stringify(error.problem)).not.toContain('PRIVATE KEY');
      expect(error.message).not.toContain('PRIVATE KEY');
    },
  );

  it('never reaches GitHub when the key is PKCS#1', async () => {
    const github = notCalled();
    const auth = new GitHubAppAuth(
      { appId: APP_ID, privateKeyPem: key.pem.replace(/PRIVATE KEY/g, 'RSA PRIVATE KEY') },
      { fetch: github.fetch },
    );
    const error = await rejection(auth.installationIdFor(REPO));
    expect(error.problem.type).toBe('github-auth');
    expect(github.calls).toHaveLength(0);
  });
});

describe('GitHubAppAuth', () => {
  it.each(['', '  ', 'abc', '0', '12 34'])(
    'refuses app id %j with 503 github-auth before any request',
    async (appId) => {
      const github = notCalled();
      const auth = new GitHubAppAuth({ appId, privateKeyPem: key.pem }, { fetch: github.fetch });
      expect((await rejection(auth.installationIdFor(REPO))).problem.type).toBe('github-auth');
      expect(github.calls).toHaveLength(0);
    },
  );

  it('looks the installation up with the app JWT and returns its id (for #15)', async () => {
    const github = scriptedGitHub(() => json(200, { id: INSTALLATION_ID, account: { login: 'geeera' } }));
    const auth = new GitHubAppAuth({ appId: APP_ID, privateKeyPem: key.pem }, { fetch: github.fetch });

    await expect(auth.installationIdFor(REPO)).resolves.toBe(INSTALLATION_ID);

    const [call] = github.calls;
    expect(call?.method).toBe('GET');
    expect(call?.url).toBe('https://api.github.com/repos/geeera/team-console/installation');
    const jwt = call?.headers.get('authorization')?.replace(/^Bearer /, '') ?? '';
    const decoded = await decodeJwt(jwt, key.publicKey);
    expect(decoded.signatureValid).toBe(true);
    expect(decoded.claims['iss']).toBe(APP_ID);
  });

  it('answers 409 github-app-not-installed with the repository when the lookup is 404 and the app exists', async () => {
    const github = scriptedGitHub((call) =>
      new URL(call.url).pathname === '/app' ? json(200, { id: 1 }) : json(404, { message: 'Not Found' }),
    );
    const auth = new GitHubAppAuth({ appId: APP_ID, privateKeyPem: key.pem }, { fetch: github.fetch });

    const error = await rejection(auth.installationIdFor(REPO));
    expect(error.problem).toMatchObject({
      type: 'github-app-not-installed',
      status: 409,
      detail: 'Install the team-console app on geeera/team-console',
    });
    // The confirmation reuses the lookup's JWT.
    expect(github.calls.map((call) => new URL(call.url).pathname)).toEqual([
      '/repos/geeera/team-console/installation',
      '/app',
    ]);
    expect(github.calls[1]?.headers.get('authorization')).toBe(github.calls[0]?.headers.get('authorization'));
  });

  // GitHub answers a JWT whose iss names no app with 404 "Integration not found" (verified 2026-09-30).
  it.each([
    [404, 'Integration not found'],
    [401, 'A JSON web token could not be decoded'],
  ])(
    'answers 503 github-auth, not 409, when GET /app is %i (wrong GITHUB_APP_ID)',
    async (status, message) => {
      const github = scriptedGitHub((call) =>
        new URL(call.url).pathname === '/app' ? json(status, { message }) : json(404, { message }),
      );
      const auth = new GitHubAppAuth({ appId: APP_ID, privateKeyPem: key.pem }, { fetch: github.fetch });

      const error = await rejection(auth.installationIdFor(REPO));
      expect(error.problem).toMatchObject({ type: 'github-auth', status: 503 });
      expect(JSON.stringify(error.problem)).not.toContain('PRIVATE KEY');
    },
  );

  it('maps a GET /app outage during the confirmation like any other GitHub failure', async () => {
    const github = scriptedGitHub((call) =>
      new URL(call.url).pathname === '/app' ? json(502, {}) : json(404, {}),
    );
    const auth = new GitHubAppAuth({ appId: APP_ID, privateKeyPem: key.pem }, { fetch: github.fetch });
    expect((await rejection(auth.installationIdFor(REPO))).problem.type).toBe('github-unavailable');
  });

  it('answers 503 github-auth when GitHub rejects the JWT', async () => {
    const github = scriptedGitHub(() => json(401, { message: 'A JSON web token could not be decoded' }));
    const auth = new GitHubAppAuth({ appId: APP_ID, privateKeyPem: key.pem }, { fetch: github.fetch });
    expect((await rejection(auth.installationIdFor(REPO))).problem).toMatchObject({
      type: 'github-auth',
      status: 503,
    });
  });

  it('answers 502 github-unexpected when the installation has no numeric id', async () => {
    const github = scriptedGitHub(() => json(200, { id: 'x' }));
    const auth = new GitHubAppAuth({ appId: APP_ID, privateKeyPem: key.pem }, { fetch: github.fetch });
    expect((await rejection(auth.installationIdFor(REPO))).problem.type).toBe('github-unexpected');
  });

  it('mints with repositories: [name] and the read-only permissions, with the JWT', async () => {
    const github = appFlow(() => json(200, {}));
    const auth = new GitHubAppAuth({ appId: APP_ID, privateKeyPem: key.pem }, { fetch: github.fetch });

    await expect(auth.tokenSourceFor(REPO).getToken()).resolves.toBe(`${SENTINEL_TOKEN}1`);

    const mint = github.calls.find((call) => call.method === 'POST');
    expect(mint?.url).toBe(`https://api.github.com/app/installations/${INSTALLATION_ID}/access_tokens`);
    expect(JSON.parse(mint?.body ?? '')).toEqual({
      repositories: ['team-console'],
      permissions: {
        metadata: 'read',
        issues: 'read',
        pull_requests: 'read',
        contents: 'read',
        actions: 'read',
      },
    });
    expect(INSTALLATION_PERMISSIONS).toEqual(JSON.parse(mint?.body ?? '').permissions);
    const jwt = mint?.headers.get('authorization')?.replace(/^Bearer /, '') ?? '';
    expect((await decodeJwt(jwt, key.publicKey)).signatureValid).toBe(true);
  });

  it('reuses a cached token until 5 minutes before expiry, then mints again', async () => {
    let now = NOW;
    const github = scriptedGitHub((call) =>
      call.method === 'POST'
        ? json(201, {
            token: `ghs_T${github.calls.length}`,
            expires_at: new Date(now + 60 * 60 * 1000).toISOString(),
            permissions: INSTALLATION_PERMISSIONS,
            repository_selection: 'selected',
          })
        : json(200, { id: INSTALLATION_ID }),
    );
    const auth = new GitHubAppAuth(
      { appId: APP_ID, privateKeyPem: key.pem },
      { fetch: github.fetch, now: () => now },
    );
    const source = auth.tokenSourceFor(REPO);

    expect(auth.hasUsableToken(REPO)).toBe(false);
    const first = await source.getToken();
    now += 54 * 60 * 1000;
    expect(auth.hasUsableToken(REPO)).toBe(true);
    expect(await source.getToken()).toBe(first);
    expect(github.calls).toHaveLength(2);

    now += 60 * 1000 + 1;
    expect(auth.hasUsableToken(REPO)).toBe(false);
    expect(await source.getToken()).not.toBe(first);
    expect(github.calls).toHaveLength(4);
  });

  it('keeps one token per repository and shares it case-insensitively', async () => {
    const github = appFlow(() => json(200, {}));
    const auth = new GitHubAppAuth({ appId: APP_ID, privateKeyPem: key.pem }, { fetch: github.fetch });

    const a = await auth.tokenSourceFor(REPO).getToken();
    const aAgain = await auth.tokenSourceFor(parseRepoName('Geeera/Team-Console')).getToken();
    const b = await auth.tokenSourceFor(parseRepoName('geeera/other')).getToken();

    expect(aAgain).toBe(a);
    expect(b).not.toBe(a);
    expect(github.minted()).toBe(2);
  });

  it('evicts a token GitHub rejected, so the next request mints a new one', async () => {
    const github = appFlow(() => json(200, {}));
    const auth = new GitHubAppAuth({ appId: APP_ID, privateKeyPem: key.pem }, { fetch: github.fetch });
    const source = auth.tokenSourceFor(REPO);

    const first = await source.getToken();
    source.invalidate('ghs_some_other_token');
    expect(await source.getToken()).toBe(first);
    source.invalidate(first);
    expect(await source.getToken()).not.toBe(first);
    expect(github.minted()).toBe(2);
  });

  it('mints once for concurrent requests on one repository', async () => {
    const github = appFlow(() => json(200, {}));
    const auth = new GitHubAppAuth({ appId: APP_ID, privateKeyPem: key.pem }, { fetch: github.fetch });
    const tokens = await Promise.all([1, 2, 3].map(async () => auth.tokenSourceFor(REPO).getToken()));
    expect(new Set(tokens).size).toBe(1);
    expect(github.minted()).toBe(1);
  });

  it('releases every caller sharing a hung mint at the deadline, then mints again on the next request', async () => {
    // The mint POST hangs on the first attempt — it settles only when `init.signal` aborts, as a real fetch
    // would — and succeeds from the second attempt. Fake timers do not advance `AbortSignal.timeout`, so the
    // deadline is shortened through `deadlineSignal` (#76) instead of waiting out the real 10 s one.
    let postAttempts = 0;
    const github = scriptedGitHub((call) => {
      if (call.method === 'GET') {
        return json(200, { id: INSTALLATION_ID });
      }
      postAttempts += 1;
      if (postAttempts === 1) {
        return new Promise<Response>((_resolve, reject) => {
          call.signal?.addEventListener('abort', () => {
            reject(new DOMException('The operation was aborted due to timeout', 'TimeoutError'));
          });
        });
      }
      return json(201, {
        token: 'ghs_fresh',
        expires_at: new Date(Date.now() + 3_600_000).toISOString(),
        permissions: INSTALLATION_PERMISSIONS,
        repository_selection: 'selected',
      });
    });
    const auth = new GitHubAppAuth(
      { appId: APP_ID, privateKeyPem: key.pem },
      { fetch: github.fetch, deadlineSignal: () => AbortSignal.timeout(20) },
    );
    const source = auth.tokenSourceFor(REPO);

    // Three concurrent callers join the one hung mint; its timeout must reject all three, not just the one
    // that started it, and the shared mint must not stay registered once it has failed.
    const results = await Promise.allSettled([1, 2, 3].map(async () => source.getToken()));
    expect(results.every((result) => result.status === 'rejected')).toBe(true);
    for (const result of results) {
      if (result.status === 'rejected') {
        expect(result.reason).toBeInstanceOf(GitHubError);
        expect((result.reason as GitHubError).problem).toMatchObject({
          type: 'github-unavailable',
          status: 502,
        });
      }
    }
    expect(postAttempts).toBe(1);

    // The next request does not join a dead mint: it starts a fresh one and succeeds.
    await expect(source.getToken()).resolves.toBe('ghs_fresh');
    expect(postAttempts).toBe(2);
  });

  it('does not cache a failed mint', async () => {
    let fail = true;
    const github = scriptedGitHub((call) => {
      if (call.method === 'GET') {
        return json(200, { id: INSTALLATION_ID });
      }
      return fail
        ? json(500, {})
        : json(201, {
            token: 'ghs_ok',
            expires_at: new Date(Date.now() + 3_600_000).toISOString(),
            permissions: INSTALLATION_PERMISSIONS,
            repository_selection: 'selected',
          });
    });
    const auth = new GitHubAppAuth({ appId: APP_ID, privateKeyPem: key.pem }, { fetch: github.fetch });
    const source = auth.tokenSourceFor(REPO);

    expect((await rejection(source.getToken())).problem.type).toBe('github-unavailable');
    fail = false;
    await expect(source.getToken()).resolves.toBe('ghs_ok');
  });

  it.each([
    ['no token', { expires_at: '2026-09-30T13:00:00Z' }],
    ['no expiry', { token: 'ghs_x' }],
    ['a bad expiry', { token: 'ghs_x', expires_at: 'soon' }],
    ['a token with whitespace', { token: 'ghs_x y', expires_at: '2026-09-30T13:00:00Z' }],
  ])('answers 502 github-unexpected for a mint response with %s', async (_label, body) => {
    const github = scriptedGitHub((call) =>
      call.method === 'GET' ? json(200, { id: INSTALLATION_ID }) : json(201, body),
    );
    const auth = new GitHubAppAuth({ appId: APP_ID, privateKeyPem: key.pem }, { fetch: github.fetch });
    expect((await rejection(auth.tokenSourceFor(REPO).getToken())).problem.type).toBe('github-unexpected');
  });

  // #76: a minted token must be refused, never used, when GitHub answers with permissions or a repository
  // scope broader (or just different) than what the console asked for.
  it.each([
    ['write instead of read on one permission', { ...INSTALLATION_PERMISSIONS, issues: 'write' }, 'selected'],
    [
      'a permission the console never asked for',
      { ...INSTALLATION_PERMISSIONS, metadata_extra: 'read' },
      'selected',
    ],
    [
      'a permission missing',
      Object.fromEntries(Object.entries(INSTALLATION_PERMISSIONS).filter(([name]) => name !== 'issues')),
      'selected',
    ],
    ['all repositories instead of one', INSTALLATION_PERMISSIONS, 'all'],
  ] as const)(
    'refuses a mint whose answer has %s with 502 github-unexpected',
    async (_label, permissions, repositorySelection) => {
      const github = scriptedGitHub((call) =>
        call.method === 'GET'
          ? json(200, { id: INSTALLATION_ID })
          : json(201, {
              token: 'ghs_broader',
              expires_at: '2026-09-30T13:00:00Z',
              permissions,
              repository_selection: repositorySelection,
            }),
      );
      const auth = new GitHubAppAuth({ appId: APP_ID, privateKeyPem: key.pem }, { fetch: github.fetch });
      const error = await rejection(auth.tokenSourceFor(REPO).getToken());
      expect(error.problem).toMatchObject({ type: 'github-unexpected', status: 502 });
      // Never cached: a request right after still has no usable token from this mismatched mint.
      expect(auth.hasUsableToken(REPO)).toBe(false);
    },
  );

  it('accepts a mint whose answer echoes exactly the requested permissions and repository_selection', async () => {
    const github = appFlow(() => json(200, {}));
    const auth = new GitHubAppAuth({ appId: APP_ID, privateKeyPem: key.pem }, { fetch: github.fetch });
    await expect(auth.tokenSourceFor(REPO).getToken()).resolves.toBe(`${SENTINEL_TOKEN}1`);
    expect(auth.hasUsableToken(REPO)).toBe(true);
  });
});

describe('the installation-wide list token (#194, ADR 0003 decisions 2(a) and 6 as amended)', () => {
  const OWNER_ID = 100001;

  /** `GET /app/installations`, the per-repo lookup and mints; tokens numbered so a re-mint is visible. */
  function listFlow(
    installations: unknown = [{ id: INSTALLATION_ID, account: { id: OWNER_ID, login: 'x' } }],
  ) {
    let minted = 0;
    const github = scriptedGitHub((call) => {
      const path = new URL(call.url).pathname;
      if (call.method === 'GET' && path === '/app/installations') {
        return json(200, installations);
      }
      if (call.method === 'GET' && /^\/repos\/[^/]+\/[^/]+\/installation$/.test(path)) {
        return json(200, { id: INSTALLATION_ID });
      }
      if (call.method === 'POST' && /^\/app\/installations\/[0-9]+\/access_tokens$/.test(path)) {
        minted += 1;
        return json(201, {
          token: `${SENTINEL_TOKEN}${minted}`,
          expires_at: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
          ...mintScopeOf(call.body),
        });
      }
      throw new Error(`unexpected ${call.method} ${path}`);
    });
    return { ...github, minted: () => minted };
  }

  const bearerOf = (headers: Headers | undefined) =>
    headers?.get('authorization')?.replace(/^Bearer /, '') ?? '';

  it('mints with exactly {"permissions":{"metadata":"read"}} and no repositories member', async () => {
    const github = listFlow();
    const auth = new GitHubAppAuth({ appId: APP_ID, privateKeyPem: key.pem }, { fetch: github.fetch });

    await expect(auth.listTokenSourceFor(INSTALLATION_ID).getToken()).resolves.toBe(`${SENTINEL_TOKEN}1`);

    const mint = github.calls.find((call) => call.method === 'POST');
    expect(mint?.body).toBe('{"permissions":{"metadata":"read"}}');
    expect(JSON.parse(mint?.body ?? '{}')).not.toHaveProperty('repositories');
    expect(mint?.url).toBe(`https://api.github.com/app/installations/${INSTALLATION_ID}/access_tokens`);
    expect((await decodeJwt(bearerOf(mint?.headers), key.publicKey)).signatureValid).toBe(true);
    // The installation is given, so the mint is the only request.
    expect(github.calls).toHaveLength(1);
  });

  it('is a source of its own kind, naming the installation and no repository', () => {
    const auth = new GitHubAppAuth({ appId: APP_ID, privateKeyPem: key.pem }, { fetch: listFlow().fetch });
    const source = auth.listTokenSourceFor(INSTALLATION_ID);
    expect(source.kind).toBe('installation-list');
    expect(source.installationId).toBe(INSTALLATION_ID);
    expect(source).not.toHaveProperty('repo');
  });

  it('caches apart from the per-repository token of the same installation, and per installation id', async () => {
    const github = listFlow();
    const auth = new GitHubAppAuth({ appId: APP_ID, privateKeyPem: key.pem }, { fetch: github.fetch });

    const list = await auth.listTokenSourceFor(INSTALLATION_ID).getToken();
    const repo = await auth.tokenSourceFor(REPO).getToken();
    const other = await auth.listTokenSourceFor(INSTALLATION_ID + 1).getToken();

    expect(new Set([list, repo, other]).size).toBe(3);
    expect(await auth.listTokenSourceFor(INSTALLATION_ID).getToken()).toBe(list);
    expect(await auth.tokenSourceFor(REPO).getToken()).toBe(repo);
    expect(github.minted()).toBe(3);
    expect(auth.hasUsableListToken(INSTALLATION_ID)).toBe(true);
    expect(auth.hasUsableListToken(INSTALLATION_ID + 2)).toBe(false);
  });

  it('renews 5 minutes before expiry and re-mints after a 401 evicts it', async () => {
    let now = Date.now();
    const github = listFlow();
    const auth = new GitHubAppAuth(
      { appId: APP_ID, privateKeyPem: key.pem },
      { fetch: github.fetch, now: () => now },
    );
    const source = auth.listTokenSourceFor(INSTALLATION_ID);

    const first = await source.getToken();
    now += 54 * 60 * 1000;
    expect(await source.getToken()).toBe(first);
    now += 2 * 60 * 1000;
    expect(auth.hasUsableListToken(INSTALLATION_ID)).toBe(false);
    const renewed = await source.getToken();
    expect(renewed).not.toBe(first);

    source.invalidate(renewed);
    expect(await source.getToken()).not.toBe(renewed);
    expect(github.minted()).toBe(3);
  });

  it.each(['all', 'selected'])(
    'accepts a list mint answered with exactly metadata: read and repository_selection %s',
    async (repositorySelection) => {
      const github = scriptedGitHub(() =>
        json(201, {
          token: 'ghs_list',
          expires_at: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
          permissions: { metadata: 'read' },
          repository_selection: repositorySelection,
        }),
      );
      const auth = new GitHubAppAuth({ appId: APP_ID, privateKeyPem: key.pem }, { fetch: github.fetch });
      await expect(auth.listTokenSourceFor(INSTALLATION_ID).getToken()).resolves.toBe('ghs_list');
    },
  );

  // #76 on the #194 token: an installation-wide token broader than `metadata: read` is refused, never cached.
  it.each([
    ['the repository token permissions', INSTALLATION_PERMISSIONS, 'all'],
    ['metadata: write', { metadata: 'write' }, 'all'],
    ['no permissions', {}, 'all'],
    ['an unknown repository_selection', { metadata: 'read' }, 'some'],
    ['no repository_selection', { metadata: 'read' }, undefined],
  ] as const)(
    'refuses a list mint answered with %s with 502 github-unexpected',
    async (_label, permissions, repositorySelection) => {
      const github = scriptedGitHub(() =>
        json(201, {
          token: 'ghs_broader',
          expires_at: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
          permissions,
          repository_selection: repositorySelection,
        }),
      );
      const auth = new GitHubAppAuth({ appId: APP_ID, privateKeyPem: key.pem }, { fetch: github.fetch });
      const error = await rejection(auth.listTokenSourceFor(INSTALLATION_ID).getToken());
      expect(error.problem).toMatchObject({ type: 'github-unexpected', status: 502 });
      expect(auth.hasUsableListToken(INSTALLATION_ID)).toBe(false);
    },
  );

  it('finds the installation by account.id against the pinned user id, not by login', async () => {
    const github = listFlow([
      { id: 11, account: { id: 7, login: 'geeera' } },
      { id: 12, account: { id: OWNER_ID, login: 'renamed-owner' } },
    ]);
    const auth = new GitHubAppAuth({ appId: APP_ID, privateKeyPem: key.pem }, { fetch: github.fetch });

    await expect(auth.installationIdForAccount(OWNER_ID)).resolves.toBe(12);

    const [call] = github.calls;
    expect(call?.url).toBe('https://api.github.com/app/installations?per_page=100');
    expect((await decodeJwt(bearerOf(call?.headers), key.publicKey)).claims['iss']).toBe(APP_ID);
  });

  it('answers 409 github-app-not-installed, naming no repository, when no installation is on the account', async () => {
    const auth = new GitHubAppAuth(
      { appId: APP_ID, privateKeyPem: key.pem },
      { fetch: listFlow([{ id: 11, account: { id: 7 } }]).fetch },
    );
    const error = await rejection(auth.installationIdForAccount(OWNER_ID));
    expect(error.problem).toMatchObject({ type: 'github-app-not-installed', status: 409 });
    expect(error.problem.detail).not.toContain('/');
  });

  it('answers 502 github-unexpected when there is no match and GitHub names another page', async () => {
    const github = scriptedGitHub(() =>
      json(200, [{ id: 11, account: { id: 7 } }], {
        link: '<https://api.github.com/app/installations?per_page=100&page=2>; rel="next"',
      }),
    );
    const auth = new GitHubAppAuth({ appId: APP_ID, privateKeyPem: key.pem }, { fetch: github.fetch });
    expect((await rejection(auth.installationIdForAccount(OWNER_ID))).problem.type).toBe('github-unexpected');
    expect(github.calls).toHaveLength(1);
  });

  it('answers 503 github-auth when GET /app/installations is 404 because the app id is wrong', async () => {
    const github = scriptedGitHub(() => json(404, { message: 'Integration not found' }));
    const auth = new GitHubAppAuth({ appId: APP_ID, privateKeyPem: key.pem }, { fetch: github.fetch });
    expect((await rejection(auth.installationIdForAccount(OWNER_ID))).problem).toMatchObject({
      type: 'github-auth',
      status: 503,
    });
    expect(github.calls.map((call) => new URL(call.url).pathname)).toEqual(['/app/installations', '/app']);
  });

  it.each([
    ['not a list', { installations: [] }],
    ['an entry without an account', [{ id: 11 }]],
    ['an account without a numeric id', [{ id: 11, account: { id: 'x' } }]],
  ])('answers 502 github-unexpected for %s', async (_label, body) => {
    const auth = new GitHubAppAuth(
      { appId: APP_ID, privateKeyPem: key.pem },
      { fetch: listFlow(body).fetch },
    );
    expect((await rejection(auth.installationIdForAccount(OWNER_ID))).problem.type).toBe('github-unexpected');
  });

  it('maps a rate-limited installations lookup to 429 with its Retry-After', async () => {
    const github = scriptedGitHub(() => json(429, {}, { 'retry-after': '7' }));
    const auth = new GitHubAppAuth({ appId: APP_ID, privateKeyPem: key.pem }, { fetch: github.fetch });
    expect((await rejection(auth.installationIdForAccount(OWNER_ID))).problem).toMatchObject({
      type: 'github-rate-limit',
      retryAfter: 7,
    });
  });
});
