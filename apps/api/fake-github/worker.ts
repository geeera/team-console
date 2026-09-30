import { FakeGitHubOAuth, type FakeFault, type FakeUser } from '@worker/github/testing';

/**
 * Local only (`nx run api:fake-github`, 127.0.0.1:9999): the fake GitHub of `@worker/github/testing` as a Worker, so
 * the owner connection (#59) runs end to end against `wrangler dev` of the api with
 * `--var GITHUB_FAKE_ORIGIN:http://127.0.0.1:9999`. The api sends https://github.com/… and https://api.github.com/…
 * here as /github.com/… and /api.github.com/…; the authorize page approves at once as the current user. Controls:
 * POST /_fake/user {"login","id"}, POST /_fake/fail {"fault"}, GET /_fake/state. Every value here is fake.
 */

interface FakeEnv {
  readonly FAKE_GITHUB_CLIENT_ID: string;
  readonly FAKE_GITHUB_CLIENT_SECRET: string;
}

let fake: FakeGitHubOAuth | undefined;

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

function isFakeUser(value: unknown): value is FakeUser {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const record = value as Record<string, unknown>;
  return typeof record['login'] === 'string' && typeof record['id'] === 'number';
}

async function control(server: FakeGitHubOAuth, request: Request, path: string): Promise<Response> {
  if (path === '/_fake/state') {
    return json(200, {
      activeGrants: server.activeGrants(),
      tokenEndpointCalls: server.refreshCalls(),
      calls: server.calls.map((call) => `${call.method} ${call.url}`),
    });
  }
  const body: unknown = await request.json();
  if (path === '/_fake/user' && isFakeUser(body)) {
    server.user = { login: body.login, id: body.id };
    return json(200, server.user);
  }
  if (path === '/_fake/fail' && typeof body === 'object' && body !== null && 'fault' in body) {
    server.fail(String(body.fault) as FakeFault);
    return json(200, body);
  }
  return json(400, { message: 'unknown control' });
}

export default {
  fetch: async (request, env) => {
    if (env.FAKE_GITHUB_CLIENT_ID === '' || env.FAKE_GITHUB_CLIENT_SECRET === '') {
      return json(500, { message: 'FAKE_GITHUB_CLIENT_ID and FAKE_GITHUB_CLIENT_SECRET are required' });
    }
    fake ??= new FakeGitHubOAuth({
      clientId: env.FAKE_GITHUB_CLIENT_ID,
      clientSecret: env.FAKE_GITHUB_CLIENT_SECRET,
    });
    const url = new URL(request.url);
    if (url.pathname.startsWith('/_fake/')) {
      return control(fake, request, url.pathname);
    }
    const [, host, ...rest] = url.pathname.split('/');
    if (host !== 'github.com' && host !== 'api.github.com') {
      return json(404, { message: 'Not Found' });
    }
    return fake.handle(new Request(`https://${host}/${rest.join('/')}${url.search}`, request));
  },
} satisfies ExportedHandler<FakeEnv>;
