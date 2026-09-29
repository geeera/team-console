import { SignJWT } from 'jose';
import { PROBLEM_TYPE_PREFIX, isProblemDetails } from '@shared/contracts';
import { createApiApp } from '../app';
import {
  AUDIENCE,
  OWNER,
  SERVICE_TOKEN_ID,
  accessEnv,
  base64url,
  createSigningKey,
  fetchApi,
  signAccessToken,
  stubJwksServer,
  uniqueTeamDomain,
  type JwksServer,
  type SigningKey,
} from '../testing/access-kit';

// Tests per row of the threat model on #8 (rows 1–4, 6–9) and the PM grooming criteria. Row 5 (CSRF) is in
// csrf.middleware.spec.ts, row 10 (ngsw) in apps/console/src/app/pwa.spec.ts.

const PROTECTED = '/api/v1/projects';

async function expectProblem(response: Response, slug: string, status = 401): Promise<void> {
  expect(response.status).toBe(status);
  expect(response.headers.get('content-type')).toBe('application/problem+json; charset=utf-8');
  const body: unknown = await response.json();
  expect(isProblemDetails(body)).toBe(true);
  expect(body).toMatchObject({ type: `${PROBLEM_TYPE_PREFIX}${slug}`, status });
}

function withToken(token: string): { headers: Record<string, string> } {
  return { headers: { 'Cf-Access-Jwt-Assertion': token } };
}

let jwks: JwksServer;
let teamDomain: string;
let key: SigningKey;

beforeEach(async () => {
  jwks = stubJwksServer();
  teamDomain = uniqueTeamDomain();
  key = await createSigningKey();
  jwks.set(teamDomain, { keys: [key.publicJwk] });
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('a valid owner token', () => {
  it('is let through', async () => {
    const token = await signAccessToken(key, teamDomain);
    const response = await fetchApi(PROTECTED, accessEnv(teamDomain), withToken(token));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual([]);
  });

  it('matches OWNER_EMAIL case-insensitively', async () => {
    const token = await signAccessToken(key, teamDomain, { claims: { email: 'Owner@Example.COM' } });
    const response = await fetchApi(PROTECTED, accessEnv(teamDomain), withToken(token));
    expect(response.status).toBe(200);
  });

  it('is accepted when aud is an array containing ours (row 3)', async () => {
    const token = await signAccessToken(key, teamDomain, { audience: ['other-app', AUDIENCE] });
    const response = await fetchApi(PROTECTED, accessEnv(teamDomain), withToken(token));
    expect(response.status).toBe(200);
  });
});

describe('a missing token', () => {
  it('gets 401 access-missing without a header', async () => {
    await expectProblem(await fetchApi(PROTECTED, accessEnv(teamDomain)), 'access-missing');
  });

  it('gets 401 access-missing for an empty header', async () => {
    await expectProblem(await fetchApi(PROTECTED, accessEnv(teamDomain), withToken('  ')), 'access-missing');
  });

  it('is not rescued by the CF_Authorization cookie (header only)', async () => {
    const token = await signAccessToken(key, teamDomain);
    const response = await fetchApi(PROTECTED, accessEnv(teamDomain), {
      headers: { Cookie: `CF_Authorization=${token}` },
    });
    await expectProblem(response, 'access-missing');
  });
});

describe('an unverifiable token gets 401 access-unverified', () => {
  it('with the wrong issuer', async () => {
    const token = await signAccessToken(key, teamDomain, { issuer: 'https://evil.cloudflareaccess.com' });
    await expectProblem(
      await fetchApi(PROTECTED, accessEnv(teamDomain), withToken(token)),
      'access-unverified',
    );
  });

  it('with the wrong audience', async () => {
    const token = await signAccessToken(key, teamDomain, { audience: 'another-access-app' });
    await expectProblem(
      await fetchApi(PROTECTED, accessEnv(teamDomain), withToken(token)),
      'access-unverified',
    );
  });

  it('with a stage audience against the production config (row 3)', async () => {
    const token = await signAccessToken(key, teamDomain, { audience: ['aud-stage'] });
    const production = accessEnv(teamDomain, { ENVIRONMENT: 'production', ACCESS_AUD: 'aud-production' });
    await expectProblem(await fetchApi(PROTECTED, production, withToken(token)), 'access-unverified');
  });

  it('when expired (beyond the 30 s clock tolerance)', async () => {
    const token = await signAccessToken(key, teamDomain, { expiresInSeconds: -120 });
    await expectProblem(
      await fetchApi(PROTECTED, accessEnv(teamDomain), withToken(token)),
      'access-unverified',
    );
  });

  it('when not yet valid (nbf in the future)', async () => {
    const token = await signAccessToken(key, teamDomain, { notBeforeInSeconds: 300 });
    await expectProblem(
      await fetchApi(PROTECTED, accessEnv(teamDomain), withToken(token)),
      'access-unverified',
    );
  });

  it('without exp — it would never expire (row 2)', async () => {
    const token = await signAccessToken(key, teamDomain, { expiresInSeconds: null });
    await expectProblem(
      await fetchApi(PROTECTED, accessEnv(teamDomain), withToken(token)),
      'access-unverified',
    );
  });

  it('without iat (row 2)', async () => {
    const token = await signAccessToken(key, teamDomain, { issuedAt: false });
    await expectProblem(
      await fetchApi(PROTECTED, accessEnv(teamDomain), withToken(token)),
      'access-unverified',
    );
  });

  it('with a bad signature', async () => {
    const token = await signAccessToken(key, teamDomain);
    const [header, payload] = token.split('.');
    const tampered = `${header}.${payload}.${base64url('not the signature')}`;
    await expectProblem(
      await fetchApi(PROTECTED, accessEnv(teamDomain), withToken(tampered)),
      'access-unverified',
    );
  });

  it('with a tampered payload', async () => {
    const token = await signAccessToken(key, teamDomain, { claims: { email: 'someone@example.com' } });
    const [header, , signature] = token.split('.');
    const forged = base64url(
      JSON.stringify({
        email: OWNER,
        iss: `https://${teamDomain}`,
        aud: [AUDIENCE],
        iat: Math.floor(Date.now() / 1000),
        exp: Math.floor(Date.now() / 1000) + 600,
      }),
    );
    await expectProblem(
      await fetchApi(PROTECTED, accessEnv(teamDomain), withToken(`${header}.${forged}.${signature}`)),
      'access-unverified',
    );
  });

  it('with alg: none (row 1)', async () => {
    const now = Math.floor(Date.now() / 1000);
    const unsigned = [
      base64url(JSON.stringify({ alg: 'none', typ: 'JWT' })),
      base64url(
        JSON.stringify({
          email: OWNER,
          iss: `https://${teamDomain}`,
          aud: [AUDIENCE],
          iat: now,
          exp: now + 600,
        }),
      ),
      '',
    ].join('.');
    await expectProblem(
      await fetchApi(PROTECTED, accessEnv(teamDomain), withToken(unsigned)),
      'access-unverified',
    );
  });

  it('when HS256-signed with the public key as the secret (row 1)', async () => {
    const now = Math.floor(Date.now() / 1000);
    const secret = new TextEncoder().encode(JSON.stringify(key.publicJwk));
    const token = await new SignJWT({ email: OWNER })
      .setProtectedHeader({ alg: 'HS256', kid: key.kid })
      .setIssuer(`https://${teamDomain}`)
      .setAudience([AUDIENCE])
      .setIssuedAt(now)
      .setExpirationTime(now + 600)
      .sign(secret);
    await expectProblem(
      await fetchApi(PROTECTED, accessEnv(teamDomain), withToken(token)),
      'access-unverified',
    );
  });

  it('when signed by another key under our kid (row 1)', async () => {
    const impostor = await createSigningKey(key.kid);
    const token = await signAccessToken(impostor, teamDomain);
    await expectProblem(
      await fetchApi(PROTECTED, accessEnv(teamDomain), withToken(token)),
      'access-unverified',
    );
  });

  it('when its kid is not in the key set', async () => {
    const unknown = await createSigningKey();
    const token = await signAccessToken(unknown, teamDomain);
    await expectProblem(
      await fetchApi(PROTECTED, accessEnv(teamDomain), withToken(token)),
      'access-unverified',
    );
  });

  it('for garbage in the header', async () => {
    await expectProblem(
      await fetchApi(PROTECTED, accessEnv(teamDomain), withToken('not-a-jwt')),
      'access-unverified',
    );
  });
});

describe('the JWKS endpoint', () => {
  it('failing with 500 rejects the request — fail closed', async () => {
    jwks.set(teamDomain, { status: 500 });
    const token = await signAccessToken(key, teamDomain);
    await expectProblem(
      await fetchApi(PROTECTED, accessEnv(teamDomain), withToken(token)),
      'access-unverified',
    );
  });

  it('being unreachable rejects the request — fail closed', async () => {
    vi.mocked(globalThis.fetch).mockRejectedValue(new TypeError('network connection lost'));
    const token = await signAccessToken(key, teamDomain);
    await expectProblem(
      await fetchApi(PROTECTED, accessEnv(teamDomain), withToken(token)),
      'access-unverified',
    );
  });

  it('is fetched from the team domain and cached across requests', async () => {
    const token = await signAccessToken(key, teamDomain);
    await fetchApi(PROTECTED, accessEnv(teamDomain), withToken(token));
    await fetchApi(PROTECTED, accessEnv(teamDomain), withToken(token));

    expect(jwks.fetchCount(teamDomain)).toBe(1);
    expect(vi.mocked(globalThis.fetch)).toHaveBeenCalledWith(
      `https://${teamDomain}/cdn-cgi/access/certs`,
      expect.objectContaining({ redirect: 'manual' }),
    );
  });

  it('is refetched for a rotated key once the cooldown has passed', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const first = await signAccessToken(key, teamDomain);
    expect((await fetchApi(PROTECTED, accessEnv(teamDomain), withToken(first))).status).toBe(200);

    const rotated = await createSigningKey();
    jwks.set(teamDomain, { keys: [rotated.publicJwk] });
    vi.setSystemTime(Date.now() + 31_000);
    const second = await signAccessToken(rotated, teamDomain);

    expect((await fetchApi(PROTECTED, accessEnv(teamDomain), withToken(second))).status).toBe(200);
    expect(jwks.fetchCount(teamDomain)).toBe(2);
  });

  it('is not refetched for unknown kids within the cooldown (row 8, no refetch flood)', async () => {
    const first = await signAccessToken(key, teamDomain);
    await fetchApi(PROTECTED, accessEnv(teamDomain), withToken(first));

    for (let attempt = 0; attempt < 3; attempt += 1) {
      const stranger = await signAccessToken(await createSigningKey(), teamDomain);
      await expectProblem(
        await fetchApi(PROTECTED, accessEnv(teamDomain), withToken(stranger)),
        'access-unverified',
      );
    }
    expect(jwks.fetchCount(teamDomain)).toBe(1);
  });
});

describe('a verified token for the wrong subject gets 401 access-forbidden', () => {
  it('when the email is not the owner', async () => {
    const token = await signAccessToken(key, teamDomain, { claims: { email: 'intruder@example.com' } });
    await expectProblem(
      await fetchApi(PROTECTED, accessEnv(teamDomain), withToken(token)),
      'access-forbidden',
    );
  });

  it('when it carries neither email nor common_name', async () => {
    const token = await signAccessToken(key, teamDomain, { claims: { email: undefined } });
    await expectProblem(
      await fetchApi(PROTECTED, accessEnv(teamDomain), withToken(token)),
      'access-forbidden',
    );
  });
});

describe('service tokens', () => {
  async function serviceToken(commonName = SERVICE_TOKEN_ID): Promise<string> {
    return signAccessToken(key, teamDomain, { claims: { email: undefined, common_name: commonName } });
  }

  it.each(['dev', 'stage'])(
    'are accepted on %s with ALLOW_SERVICE_TOKEN=true and the pinned id',
    async (name) => {
      const response = await fetchApi(
        PROTECTED,
        accessEnv(teamDomain, { ENVIRONMENT: name }),
        withToken(await serviceToken()),
      );
      expect(response.status).toBe(200);
    },
  );

  it('are rejected in production even with ALLOW_SERVICE_TOKEN=true', async () => {
    const production = accessEnv(teamDomain, { ENVIRONMENT: 'production', ALLOW_SERVICE_TOKEN: 'true' });
    await expectProblem(
      await fetchApi(PROTECTED, production, withToken(await serviceToken())),
      'access-forbidden',
    );
  });

  it('are rejected in production with the committed config (ALLOW_SERVICE_TOKEN=false)', async () => {
    const production = accessEnv(teamDomain, { ENVIRONMENT: 'production', ALLOW_SERVICE_TOKEN: 'false' });
    await expectProblem(
      await fetchApi(PROTECTED, production, withToken(await serviceToken())),
      'access-forbidden',
    );
  });

  it('are rejected on stage when ALLOW_SERVICE_TOKEN is not exactly "true"', async () => {
    const stage = accessEnv(teamDomain, { ENVIRONMENT: 'stage', ALLOW_SERVICE_TOKEN: 'yes' });
    await expectProblem(
      await fetchApi(PROTECTED, stage, withToken(await serviceToken())),
      'access-forbidden',
    );
  });

  it('with another common_name are rejected on stage (row 4)', async () => {
    const stage = accessEnv(teamDomain, { ENVIRONMENT: 'stage' });
    await expectProblem(
      await fetchApi(PROTECTED, stage, withToken(await serviceToken('other-client.access'))),
      'access-forbidden',
    );
  });

  it('are rejected on stage when no ACCESS_SERVICE_TOKEN_ID is pinned', async () => {
    const stage = accessEnv(teamDomain, { ENVIRONMENT: 'stage', ACCESS_SERVICE_TOKEN_ID: '' });
    await expectProblem(
      await fetchApi(PROTECTED, stage, withToken(await serviceToken())),
      'access-forbidden',
    );
  });
});

describe('missing or malformed configuration fails closed with 401 access-misconfigured', () => {
  it.each([
    ['ACCESS_TEAM_DOMAIN empty', { ACCESS_TEAM_DOMAIN: '' }],
    ['ACCESS_AUD empty', { ACCESS_AUD: '' }],
    ['ACCESS_AUD blank', { ACCESS_AUD: '   ' }],
    ['OWNER_EMAIL unset', { OWNER_EMAIL: undefined }],
    ['OWNER_EMAIL empty', { OWNER_EMAIL: '' }],
    ['ENVIRONMENT unknown', { ENVIRONMENT: 'prod' }],
    ['ACCESS_TEAM_DOMAIN not an Access domain (row 8)', { ACCESS_TEAM_DOMAIN: 'evil.example.com' }],
    ['ACCESS_TEAM_DOMAIN with a path', { ACCESS_TEAM_DOMAIN: 'team.cloudflareaccess.com/x' }],
    ['ACCESS_TEAM_DOMAIN with a scheme', { ACCESS_TEAM_DOMAIN: 'https://team.cloudflareaccess.com' }],
    ['ACCESS_TEAM_DOMAIN a lookalike suffix', { ACCESS_TEAM_DOMAIN: 'team.cloudflareaccess.com.evil.io' }],
  ])('%s', async (_name, overrides) => {
    const token = await signAccessToken(key, teamDomain);
    const response = await fetchApi(PROTECTED, accessEnv(teamDomain, overrides), withToken(token));

    await expectProblem(response, 'access-misconfigured');
    expect(jwks.fetchCount(teamDomain)).toBe(0);
  });

  it('with the committed dev config as is (empty Access vars, no OWNER_EMAIL secret)', async () => {
    const committed = accessEnv(teamDomain, {
      ACCESS_TEAM_DOMAIN: '',
      ACCESS_AUD: '',
      OWNER_EMAIL: undefined,
      ACCESS_SERVICE_TOKEN_ID: '',
    });
    await expectProblem(await fetchApi(PROTECTED, committed), 'access-misconfigured');
  });
});

describe('the local bypass (row 7)', () => {
  it('lets a request through with ENVIRONMENT=local and AUTH_MODE=local and no token', async () => {
    const local = accessEnv(teamDomain, { ENVIRONMENT: 'local', AUTH_MODE: 'local' });
    expect((await fetchApi(PROTECTED, local)).status).toBe(200);
  });

  it.each(['dev', 'stage', 'production'])('is off with AUTH_MODE=local on %s', async (name) => {
    const deployed = accessEnv(teamDomain, { ENVIRONMENT: name, AUTH_MODE: 'local' });
    await expectProblem(await fetchApi(PROTECTED, deployed), 'access-missing');
  });

  it('is off with ENVIRONMENT=local alone', async () => {
    const local = accessEnv(teamDomain, { ENVIRONMENT: 'local', AUTH_MODE: undefined });
    await expectProblem(await fetchApi(PROTECTED, local), 'access-missing');
  });

  it('is off when the flags differ in case', async () => {
    const local = accessEnv(teamDomain, { ENVIRONMENT: 'local', AUTH_MODE: 'LOCAL' });
    await expectProblem(await fetchApi(PROTECTED, local), 'access-missing');
  });
});

describe('route inventory (row 6)', () => {
  function concretePath(pattern: string): string {
    return pattern.replace(/:[^/]+/g, 'x').replace(/\*/g, 'x');
  }

  const apiRoutes = createApiApp()
    .routes.filter((route) => route.path === '/api' || route.path.startsWith('/api/'))
    .filter((route) => route.method !== 'ALL')
    .map((route) => [route.method, concretePath(route.path)] as const);

  it('finds the API routes (the inventory is not vacuous)', () => {
    expect(apiRoutes).toEqual(
      expect.arrayContaining([
        ['GET', '/api/v1/healthz'],
        ['GET', '/api/v1/projects'],
      ]),
    );
  });

  it.each(apiRoutes)('%s %s answers 401 without a JWT', async (method, path) => {
    await expectProblem(await fetchApi(path, accessEnv(teamDomain), { method }), 'access-missing');
  });

  it.each(['/api', '/api/', '/api/v1', '/api/v1/', '/api/v1/nope', '/api/v2/x', '/api/v1/healthz/'])(
    'GET %s answers 401 without a JWT, known route or not',
    async (path) => {
      await expectProblem(await fetchApi(path, accessEnv(teamDomain)), 'access-missing');
    },
  );
});

describe('logging (row 9)', () => {
  it('records the identity kind only — never the token or the email', async () => {
    const lines: string[] = [];
    const sentinelEmail = 'sentinel-owner@example.net';
    const token = await signAccessToken(key, teamDomain, { claims: { email: sentinelEmail } });

    const granted = await fetchApi(PROTECTED, accessEnv(teamDomain, { OWNER_EMAIL: sentinelEmail }), {
      ...withToken(token),
      logSink: (line) => lines.push(line),
    });
    const refused = await fetchApi(PROTECTED, accessEnv(teamDomain), {
      ...withToken(token),
      logSink: (line) => lines.push(line),
    });
    const misconfigured = await fetchApi(
      PROTECTED,
      accessEnv(teamDomain, { OWNER_EMAIL: sentinelEmail, ACCESS_AUD: '' }),
      { ...withToken(token), logSink: (line) => lines.push(line) },
    );

    expect([granted.status, refused.status, misconfigured.status]).toEqual([200, 401, 401]);
    const log = lines.join('\n');
    expect(log).toContain('"identity":"user"');
    expect(log).toContain('"reason":"access-forbidden"');
    expect(log).toContain('"invalid":["ACCESS_AUD"]');
    expect(log).not.toContain(sentinelEmail);
    expect(log).not.toContain(OWNER);
    for (const part of token.split('.')) {
      expect(log).not.toContain(part);
    }
  });
});
