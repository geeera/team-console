import { randomUUID } from 'node:crypto';
import { createServer, type IncomingHttpHeaders, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { expect, test } from '@playwright/test';
import { routeAccessHeaders, scopeAccessHeaders, type AccessHeaders } from './support/access-headers';

/**
 * #142: the Cloudflare Access service token reaches the target's origin and no other. Two throwaway origins on
 * 127.0.0.1 stand in for the target (A) and any other site (B); both record the headers they receive. Plain
 * `@playwright/test`, not the suite's fixtures: this spec needs no stack, and B is meant to be requested here.
 */

interface Seen {
  readonly path: string;
  readonly headers: IncomingHttpHeaders;
}

interface Origin {
  readonly url: string;
  readonly seen: Seen[];
  close(): Promise<void>;
}

const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

async function origin(page: (other: string) => string, other: () => string): Promise<Origin> {
  const seen: Seen[] = [];
  const server: Server = createServer((request, response) => {
    const path = request.url ?? '/';
    seen.push({ path, headers: request.headers });
    if (path === '/') {
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(page(other()));
    } else if (path === '/to-other') {
      response.writeHead(302, { location: `${other()}/redirected` }).end();
    } else if (path.endsWith('.png')) {
      response.writeHead(200, { 'content-type': 'image/png', 'access-control-allow-origin': '*' }).end(PNG);
    } else {
      response.writeHead(200, { 'content-type': 'text/plain', 'access-control-allow-origin': '*' }).end('ok');
    }
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    seen,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      }),
  };
}

function accessHeadersIn(seen: readonly Seen[]): string[] {
  return seen.flatMap(({ path, headers }) =>
    Object.keys(headers)
      .filter((name) => name.startsWith('cf-access-'))
      .map((name) => `${path}: ${name}`),
  );
}

// The target's responses reach the browser through route.fulfill, which Chromium places in no known address space,
// so its Local Network Access checks would block A's page from requesting B on 127.0.0.1. Stage and any site it
// links to are public, where no such check applies.
test.use({
  launchOptions: {
    args: [
      '--disable-features=LocalNetworkAccessChecks,PrivateNetworkAccessRespectPreflightResults,BlockInsecurePrivateNetworkRequests',
    ],
  },
});

let target: Origin;
let other: Origin;
// Built at run time: a dummy, never a literal that looks like a credential.
const access: AccessHeaders = {
  'CF-Access-Client-Id': `${randomUUID()}.access`,
  'CF-Access-Client-Secret': randomUUID().replaceAll('-', ''),
};

test.beforeEach(async () => {
  target = await origin(
    (b) => `<!doctype html><title>A</title>
      <img alt="" src="/own.png"><img alt="" src="${b}/other.png">
      <script>fetch('/own-fetch'); fetch('${b}/other-fetch'); fetch('/to-other');</script>`,
    () => other.url,
  );
  other = await origin(
    () => '<!doctype html><title>B</title>',
    () => target.url,
  );
});

test.afterEach(async () => {
  await Promise.all([target.close(), other.close()]);
});

test('the browser sends the Access headers to the target only, also across a redirect', async ({
  context,
  page,
}) => {
  await routeAccessHeaders(context, target.url, access);

  await page.goto(`${target.url}/`);
  const paths = (seen: readonly Seen[]): string[] => seen.map(({ path }) => path);
  await expect
    .poll(() => paths(other.seen))
    .toEqual(expect.arrayContaining(['/other-fetch', '/other.png', '/redirected']));
  await expect
    .poll(() => paths(target.seen))
    .toEqual(expect.arrayContaining(['/', '/own.png', '/own-fetch', '/to-other']));

  for (const { path, headers } of target.seen) {
    expect(headers['cf-access-client-id'], path).toBe(access['CF-Access-Client-Id']);
    expect(headers['cf-access-client-secret'], path).toBe(access['CF-Access-Client-Secret']);
  }
  expect(accessHeadersIn(other.seen), 'CF-Access-* headers that reached the other origin').toEqual([]);

  // A navigation to the other site (a link the owner follows) carries none either.
  await page.goto(`${other.url}/`);
  expect(accessHeadersIn(other.seen)).toEqual([]);
});

test('the request fixture sends the Access headers to the target only and follows no redirect', async ({
  request,
}) => {
  const scoped = scopeAccessHeaders(request, target.url, access);

  expect((await scoped.get(`${target.url}/own-api`)).status()).toBe(200);
  expect((await scoped.get(`${other.url}/other-api`)).status()).toBe(200);
  const redirect = await scoped.get(`${target.url}/to-other`);
  expect(redirect.status()).toBe(302);
  expect(redirect.headers()['location']).toBe(`${other.url}/redirected`);

  expect(target.seen.map(({ path }) => path)).toEqual(['/own-api', '/to-other']);
  for (const { path, headers } of target.seen) {
    expect(headers['cf-access-client-secret'], path).toBe(access['CF-Access-Client-Secret']);
  }
  expect(other.seen.map(({ path }) => path)).toEqual(['/other-api']);
  expect(accessHeadersIn(other.seen), 'CF-Access-* headers that reached the other origin').toEqual([]);
});
