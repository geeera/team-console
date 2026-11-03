import { SELF } from 'cloudflare:test';

// The console's own `_headers` applied by the assets layer, as in production (vitest.config.mts copies the file next
// to the test shell). A stale ngsw.json, worker script or shell keeps an installed PWA on an old version (#306).
const ORIGIN = 'http://api.test';

describe('caching of the version metadata (#306)', () => {
  it.each(['/', '/ngsw.json', '/ngsw-worker.js', '/ngsw.json?ngsw-cache-bust=0.42'])(
    '%s is served no-cache',
    async (path) => {
      const response = await SELF.fetch(`${ORIGIN}${path}`);

      expect(response.status).toBe(200);
      expect(response.headers.get('cache-control')).toBe('no-cache');
    },
  );

  it('/index.html redirects to the shell at / and is no-cache itself', async () => {
    const response = await SELF.fetch(`${ORIGIN}/index.html`, { redirect: 'manual' });

    expect(response.headers.get('cache-control')).toBe('no-cache');
  });

  it.each(['/p/team-console/questions', '/needs-you', '/overview', '/settings', '/settings/language'])(
    'the shell answered for the client-side route %s is no-cache',
    async (path) => {
      const response = await SELF.fetch(`${ORIGIN}${path}`, {
        headers: { 'Sec-Fetch-Mode': 'navigate', Accept: 'text/html' },
      });

      expect(response.headers.get('content-type')).toContain('text/html');
      expect(response.headers.get('cache-control')).toBe('no-cache');
    },
  );

  it('leaves a hashed file to the default caching', async () => {
    const response = await SELF.fetch(`${ORIGIN}/asset.js`);

    expect(response.headers.get('cache-control')).not.toContain('no-cache');
  });
});
