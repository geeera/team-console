import { generateKeyPairSync } from 'node:crypto';
import { JOB_ID, fakeConsole, jobFixture, json } from '../testing/fake-console';
import { publicJwkOf } from '../config/runner-key';
import { ActionsRunError, idTokenRequestUrlOf, postOidcExchange, requestActionsIdToken } from './actions-oidc';
import { RunnerApiError } from './runner-client';

/** #669: GitHub's token request and the console's exchange, as the run makes them, and what their refusals say. */

const REQUEST_TOKEN = `${'R'.repeat(24)}.${'r'.repeat(40)}`;
const ID_TOKEN = `eyJ${'h'.repeat(20)}.eyJ${'p'.repeat(60)}.${'s'.repeat(86)}`;

describe('idTokenRequestUrlOf', () => {
  it('takes GitHub’s https URL with its query, and loopback http for the local stack', () => {
    expect(
      idTokenRequestUrlOf('https://pipelines.actions.githubusercontent.com/x/_apis/token?api-version=2.0')?.toString(),
    ).toBe('https://pipelines.actions.githubusercontent.com/x/_apis/token?api-version=2.0');
    expect(idTokenRequestUrlOf('http://127.0.0.1:4000/token')).not.toBeNull();
  });

  it.each(['http://pipelines.example/token', 'https://user:pass@pipelines.example/', 'https://p.example/#x', 'not a url'])(
    'refuses %s',
    (value) => {
      expect(idTokenRequestUrlOf(value)).toBeNull();
    },
  );
});

describe('requestActionsIdToken', () => {
  const request = (url = 'https://pipelines.example/token?api-version=2.0') => ({
    url: new URL(url),
    token: REQUEST_TOKEN,
    audience: 'team-console:prod',
  });

  it('asks for the console’s audience with the request token as the bearer, never following a redirect', async () => {
    const fake = fakeConsole(() => json(200, { count: 1, value: ID_TOKEN }));
    await expect(requestActionsIdToken(request(), fake.fetch)).resolves.toBe(ID_TOKEN);
    const [sent] = fake.requests;
    expect(sent?.url).toBe('https://pipelines.example/token?api-version=2.0&audience=team-console%3Aprod');
    expect(sent?.headers['authorization']).toBe(`Bearer ${REQUEST_TOKEN}`);
    expect(sent?.redirect).toBe('manual');
  });

  it('replaces an audience already in the URL instead of sending two', async () => {
    const fake = fakeConsole(() => json(200, { value: ID_TOKEN }));
    await requestActionsIdToken(request('https://pipelines.example/token?audience=other'), fake.fetch);
    expect(new URL(fake.requests[0]?.url ?? '').searchParams.getAll('audience')).toEqual(['team-console:prod']);
  });

  it.each([
    ['a redirect', () => new Response(null, { status: 302, headers: { Location: 'https://evil.example/' } })],
    ['a refusal', () => json(403, { message: REQUEST_TOKEN })],
    ['a body that is not JSON', () => new Response('<html>', { status: 200 })],
    ['no token', () => json(200, { count: 0 })],
    ['a value that is not a JWS', () => json(200, { value: 'abc' })],
    ['an oversized value', () => json(200, { value: `${'a'.repeat(9000)}.b.c` })],
  ])('refuses %s with a plain message that quotes nothing', async (_label, answer) => {
    const fake = fakeConsole(answer);
    const refused = requestActionsIdToken(request(), fake.fetch);
    await expect(refused).rejects.toThrow(ActionsRunError);
    await expect(refused).rejects.not.toThrow(REQUEST_TOKEN);
  });

  it('says the endpoint could not be reached on a network failure', async () => {
    const refused = requestActionsIdToken(request(), async () => {
      throw new TypeError('fetch failed');
    });
    await expect(refused).rejects.toThrow('GitHub’s OIDC token endpoint could not be reached.');
  });
});

describe('postOidcExchange', () => {
  const input = {
    idToken: ID_TOKEN,
    jobId: JOB_ID,
    publicKey: publicJwkOf(generateKeyPairSync('ed25519').privateKey),
    version: '0.4.0',
    host: { os: 'linux', arch: 'x64', hostname: 'fv-az123-456' },
  };

  it('posts the body as is to the console’s exchange route, without a bearer and without following redirects', async () => {
    const fake = fakeConsole(() => json(500, {}));
    await expect(postOidcExchange('https://console.example', input, fake.fetch)).rejects.toThrow(RunnerApiError);
    const [sent] = fake.requests;
    expect(sent?.url).toBe('https://console.example/api/v1/runner/oidc-exchange');
    expect(JSON.parse(sent?.body ?? '{}')).toEqual(input);
    expect(sent?.headers['authorization']).toBeUndefined();
    expect(sent?.redirect).toBe('manual');
  });

  it('names the problem and the claim of a refusal, and never an unknown claim value', async () => {
    const refusal = (claim: unknown) => () =>
      json(401, { type: 'https://team-console/problems/oidc-exchange-refused', title: 'Unauthorized', status: 401, claim });
    await expect(postOidcExchange('https://console.example', input, fakeConsole(refusal('ref')).fetch)).rejects.toThrow(
      /^the console answered 401 \(oidc-exchange-refused, claim ref\)$/,
    );
    await expect(
      postOidcExchange('https://console.example', input, fakeConsole(refusal(`${ID_TOKEN} sneaked in`)).fetch),
    ).rejects.toThrow(/^the console answered 401 \(oidc-exchange-refused\)$/);
  });

  it('refuses an answer that is not the exchange response', async () => {
    const fake = fakeConsole(() => json(200, { job: { id: JOB_ID } }));
    await expect(postOidcExchange('https://console.example', input, fake.fetch)).rejects.toThrow(
      'oidc exchange: unexpected answer',
    );
  });

  it('passes a malformed teamConfig through unjudged (#741) instead of throwing on it', async () => {
    const exchangeAnswer = {
      job: jobFixture({ dispatch: 'actions' }),
      jobToken: `tcj_${'J'.repeat(43)}`,
      leaseSeconds: 300,
      teamConfig: { roles: 'not-a-record' },
      teamConfigRevision: 7,
      runner: { id: '01JC00000000000000000000R1', audience: 'team-console:dev' },
    };
    const fake = fakeConsole(() => json(200, exchangeAnswer));
    const answer = await postOidcExchange('https://console.example', input, fake.fetch);
    expect(answer.teamConfig).toEqual({ roles: 'not-a-record' });
  });
});
