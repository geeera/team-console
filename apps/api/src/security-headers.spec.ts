import { SELF } from 'cloudflare:test';

// The policy comes from apps/console/public/_headers, applied by the assets layer (#118, ADR 0001 decision 8);
// vitest.config.mts puts that very file next to the test shell.
const ORIGIN = 'http://api.test';

function directivesOf(response: Response): Map<string, readonly string[]> {
  const policy = response.headers.get('content-security-policy');
  if (policy === null) {
    throw new Error('no Content-Security-Policy header');
  }
  const directives = new Map<string, readonly string[]>();
  for (const part of policy.split(';')) {
    const [name, ...sources] = part.trim().split(/\s+/);
    if (name !== undefined && name !== '') {
      directives.set(name, sources);
    }
  }
  return directives;
}

function expectSecurityHeaders(response: Response): void {
  expect(response.status).toBe(200);
  const csp = directivesOf(response);
  expect(csp.get('default-src')).toEqual(["'self'"]);
  expect(csp.get('script-src')).toEqual(["'self'"]);
  expect(csp.get('connect-src')).toEqual(["'self'"]);
  expect(csp.get('frame-ancestors')).toEqual(["'none'"]);
  // #20: the console may frame only these families; the app narrows it to each project's exact origins.
  expect(csp.get('frame-src')).toEqual([
    "'self'",
    'https://*.pages.dev',
    'https://*.workers.dev',
    'https://*.github.io',
  ]);
  expect(csp.get('base-uri')).toEqual(["'self'"]);
  expect(csp.get('form-action')).toEqual(["'self'"]);
  expect(csp.get('object-src')).toEqual(["'none'"]);
  expect(response.headers.get('x-frame-options')).toBe('DENY');
  expect(response.headers.get('x-content-type-options')).toBe('nosniff');
  expect(response.headers.get('referrer-policy')).toBe('same-origin');
}

describe('security headers on what the console serves (#118)', () => {
  it('are sent with the HTML shell', async () => {
    const response = await SELF.fetch(`${ORIGIN}/`);

    expect(response.headers.get('content-type')).toContain('text/html');
    expectSecurityHeaders(response);
  });

  it('are sent with the shell answered for a client-side route (SPA fallback)', async () => {
    const response = await SELF.fetch(`${ORIGIN}/p/team-console/questions`, {
      headers: { 'Sec-Fetch-Mode': 'navigate', Accept: 'text/html' },
    });

    expect(response.headers.get('content-type')).toContain('text/html');
    expectSecurityHeaders(response);
  });

  it('are sent with a static asset', async () => {
    const response = await SELF.fetch(`${ORIGIN}/asset.js`);

    expect(response.headers.get('content-type')).toContain('javascript');
    expectSecurityHeaders(response);
  });

  it('never allow eval anywhere, nor inline script', async () => {
    const response = await SELF.fetch(`${ORIGIN}/`);
    const csp = directivesOf(response);

    for (const [name, sources] of csp) {
      expect(sources, name).not.toContain("'unsafe-eval'");
      expect(sources, name).not.toContain("'wasm-unsafe-eval'");
    }
    expect(csp.get('script-src')).not.toContain("'unsafe-inline'");
  });

  it('does not serve the headers file itself', async () => {
    const response = await SELF.fetch(`${ORIGIN}/_headers`);

    await expect(response.text()).resolves.not.toContain('Content-Security-Policy');
  });
});
