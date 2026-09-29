import {
  INSTALLATION_ID,
  SENTINEL_TOKEN,
  appFlow,
  decodeJwt,
  generateAppKey,
  json,
  scriptedGitHub,
  type AppKey,
} from '../testing/github-kit';
import { GitHubAppAuth, INSTALLATION_PERMISSIONS, createAppJwt, importAppPrivateKey } from './app-auth';
import { GitHubError } from './errors';
import { parseRepoName } from './repo-name';

const APP_ID = '123456';
const REPO = parseRepoName('geeera/team-console');
const NOW = Date.parse('2026-09-30T12:00:00Z');

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
    ['a public key', () => '-----BEGIN PUBLIC KEY-----\nMIIB\n-----END PUBLIC KEY-----'],
    ['an empty value', () => ''],
    ['base64 of the PEM', (key) => btoa(key.pem)],
    ['broken base64', () => '-----BEGIN PRIVATE KEY-----\n@@@@\n-----END PRIVATE KEY-----'],
    ['DER that is not a key', () => '-----BEGIN PRIVATE KEY-----\nAAAA\n-----END PRIVATE KEY-----'],
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
          })
        : json(200, { id: INSTALLATION_ID }),
    );
    const auth = new GitHubAppAuth(
      { appId: APP_ID, privateKeyPem: key.pem },
      { fetch: github.fetch, now: () => now },
    );
    const source = auth.tokenSourceFor(REPO);

    const first = await source.getToken();
    now += 54 * 60 * 1000;
    expect(await source.getToken()).toBe(first);
    expect(github.calls).toHaveLength(2);

    now += 60 * 1000 + 1;
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

  it('does not cache a failed mint', async () => {
    let fail = true;
    const github = scriptedGitHub((call) => {
      if (call.method === 'GET') {
        return json(200, { id: INSTALLATION_ID });
      }
      return fail
        ? json(500, {})
        : json(201, { token: 'ghs_ok', expires_at: new Date(Date.now() + 3_600_000).toISOString() });
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
});
