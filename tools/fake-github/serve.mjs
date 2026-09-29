#!/usr/bin/env node
// Local only: serves the fake GitHub of apps/api/src/testing/fake-github-oauth.ts (the one the api specs use) on
// 127.0.0.1, so the owner connection (#59) can be run end to end against `wrangler dev`:
//
//   FAKE_GITHUB_CLIENT_ID=Iv23liLOCAL FAKE_GITHUB_CLIENT_SECRET=local-fake-secret node tools/fake-github/serve.mjs
//   npx wrangler dev --config apps/api/wrangler.jsonc --env dev --port 8787 --var ENVIRONMENT:local \
//     --var AUTH_MODE:local --var GITHUB_FAKE_ORIGIN:http://127.0.0.1:9999 --var GITHUB_APP_CLIENT_ID:Iv23liLOCAL \
//     --var OWNER_GITHUB_LOGIN:<login> --var GITHUB_APP_CLIENT_SECRET:local-fake-secret \
//     --var TOKEN_ENCRYPTION_KEY:$(openssl rand -base64 32)
//
// The Worker sends https://github.com/… and https://api.github.com/… here as /github.com/… and /api.github.com/…
// (GITHUB_FAKE_ORIGIN, honoured only with ENVIRONMENT=local). The authorize page approves at once as the current
// user and redirects to redirect_uri. Controls: POST /_fake/user {"login","id"}, POST /_fake/fail {"fault"}
// (see FakeFault), GET /_fake/state. Every value here is fake; never point this at real credentials.
// Needs Node's TypeScript type stripping (default from Node 22.18; older 22.x: --experimental-strip-types).
import { createServer } from 'node:http';
import { FakeGitHubOAuth } from '../../apps/api/src/testing/fake-github-oauth.ts';

const port = Number(process.env.FAKE_GITHUB_PORT ?? '9999');
const clientId = process.env.FAKE_GITHUB_CLIENT_ID ?? '';
const clientSecret = process.env.FAKE_GITHUB_CLIENT_SECRET ?? '';
if (clientId === '' || clientSecret === '') {
  console.error('FAKE_GITHUB_CLIENT_ID and FAKE_GITHUB_CLIENT_SECRET are required');
  process.exit(2);
}
const fake = new FakeGitHubOAuth({
  clientId,
  clientSecret,
  ...(process.env.FAKE_GITHUB_ACCESS_SECONDS === undefined
    ? {}
    : { accessLifetimeSeconds: Number(process.env.FAKE_GITHUB_ACCESS_SECONDS) }),
});

async function bodyOf(request) {
  const chunks = [];
  for await (const chunk of request) {
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

function reply(response, status, body) {
  response.writeHead(status, { 'Content-Type': 'application/json' });
  response.end(JSON.stringify(body));
}

const server = createServer(async (request, response) => {
  try {
    const url = new URL(request.url ?? '/', `http://127.0.0.1:${port}`);
    const body = await bodyOf(request);
    if (url.pathname === '/_fake/user' && request.method === 'POST') {
      fake.user = JSON.parse(body);
      console.log(`fake: authorize page now approves as ${fake.user.login} (${fake.user.id})`);
      return reply(response, 200, fake.user);
    }
    if (url.pathname === '/_fake/fail' && request.method === 'POST') {
      const { fault } = JSON.parse(body);
      fake.fail(fault);
      console.log(`fake: next ${fault}`);
      return reply(response, 200, { fault });
    }
    if (url.pathname === '/_fake/state') {
      return reply(response, 200, {
        activeGrants: fake.activeGrants(),
        tokenEndpointCalls: fake.refreshCalls(),
        calls: fake.calls.map((call) => `${call.method} ${call.url}`),
      });
    }
    const [, host, ...rest] = url.pathname.split('/');
    if (host !== 'github.com' && host !== 'api.github.com') {
      return reply(response, 404, { message: 'Not Found' });
    }
    const upstream = new Request(`https://${host}/${rest.join('/')}${url.search}`, {
      method: request.method,
      headers: Object.entries(request.headers).flatMap(([name, value]) =>
        typeof value === 'string' ? [[name, value]] : [],
      ),
      ...(body === '' ? {} : { body }),
    });
    const answer = await fake.handle(upstream);
    // Path only: the query and the body carry codes and tokens.
    console.log(`fake: ${request.method} https://${host}/${rest.join('/')} -> ${answer.status}`);
    response.writeHead(answer.status, Object.fromEntries(answer.headers.entries()));
    response.end(Buffer.from(await answer.arrayBuffer()));
  } catch (error) {
    console.error('fake: request failed', error instanceof Error ? error.message : String(error));
    reply(response, 500, { message: 'fake GitHub error' });
  }
});

server.listen(port, '127.0.0.1', () => {
  console.log(`fake GitHub on http://127.0.0.1:${port} (client ${clientId})`);
});
