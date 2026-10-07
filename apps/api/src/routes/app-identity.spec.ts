import { SELF, env } from 'cloudflare:test';
import { ENVIRONMENTS, isProblemDetails, PROBLEM_TYPE_PREFIX, type Environment } from '@shared/contracts';
import type { ApiEnv } from '../env';
import { fetchApi } from '../testing/access-kit';

// #237: one console build, so the Worker names and draws the installed app per ENVIRONMENT.
const ORIGIN = 'http://api.test';

const bindings = (environment: string): ApiEnv => ({ ...env, ENVIRONMENT: environment }) as ApiEnv;

async function manifestOf(environment: Environment): Promise<Record<string, unknown>> {
  const response = await fetchApi('/manifest.webmanifest', bindings(environment));
  expect(response.status).toBe(200);
  expect(response.headers.get('content-type')).toBe('application/manifest+json; charset=utf-8');
  const body: unknown = await response.json();
  if (typeof body !== 'object' || body === null) {
    throw new Error('the manifest is not a JSON object');
  }
  return body as Record<string, unknown>;
}

describe('GET /manifest.webmanifest', () => {
  it.each([
    ['production', 'Team Console', 'Console'],
    ['dev', 'Team Console Dev', 'TC Dev'],
    ['stage', 'Team Console Stage', 'TC Stage'],
    ['local', 'Team Console Local', 'TC Local'],
  ] as const)('names the %s app %s / %s and points at its own icon set', async (environment, name, shortName) => {
    const manifest = await manifestOf(environment);

    expect(manifest).toMatchObject({
      name,
      short_name: shortName,
      start_url: '/',
      scope: '/',
      display: 'standalone',
    });
    const icons = manifest['icons'] as readonly { src: string; purpose: string }[];
    expect(icons.map((icon) => icon.src)).toEqual([
      `/icons/${environment}/icon-192.png`,
      `/icons/${environment}/icon-512.png`,
      `/icons/${environment}/icon-512.png`,
      `/icons/${environment}/apple-touch-icon.png`,
    ]);
    expect(icons.some((icon) => icon.purpose === 'maskable')).toBe(true);
  });

  it.each(ENVIRONMENTS)('lists only icons the %s assets actually serve', async (environment) => {
    const manifest = await manifestOf(environment);
    for (const { src } of manifest['icons'] as readonly { src: string }[]) {
      const icon = await SELF.fetch(`${ORIGIN}${src}`);
      expect(icon.status, src).toBe(200);
      expect(icon.headers.get('content-type'), src).toBe('image/png');
    }
  });

  it('is what the edge sends to the Worker first (run_worker_first), revalidated on each check', async () => {
    const response = await SELF.fetch(`${ORIGIN}/manifest.webmanifest`);

    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-cache');
    expect(response.headers.get('x-content-type-options')).toBe('nosniff');
    await expect(response.json()).resolves.toMatchObject({ name: 'Team Console Local' });
  });

  it('fails closed with a problem on an unknown ENVIRONMENT instead of guessing production', async () => {
    const response = await fetchApi('/manifest.webmanifest', bindings('prod'));

    expect(response.status).toBe(500);
    const body: unknown = await response.json();
    expect(isProblemDetails(body) && body.type).toBe(`${PROBLEM_TYPE_PREFIX}misconfigured`);
  });
});

describe('GET /brand/* (the icons index.html links to)', () => {
  it.each([
    ['production', '/brand/apple-touch-icon.png', '/icons/production/apple-touch-icon.png', 'image/png'],
    ['dev', '/brand/apple-touch-icon.png', '/icons/dev/apple-touch-icon.png', 'image/png'],
    ['stage', '/brand/favicon.ico', '/icons/stage/favicon.ico', 'image/vnd.microsoft.icon'],
    ['local', '/brand/favicon.ico', '/icons/local/favicon.ico', 'image/vnd.microsoft.icon'],
  ] as const)('answers %s %s with %s', async (environment, path, file, type) => {
    const response = await fetchApi(path, bindings(environment));
    const expected = await SELF.fetch(`${ORIGIN}${file}`);

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe(type);
    expect(response.headers.get('cache-control')).toBe('public, max-age=3600');
    expect(response.headers.get('x-content-type-options')).toBe('nosniff');
    const [served, original] = await Promise.all([response.arrayBuffer(), expected.arrayBuffer()]);
    expect(served.byteLength).toBeGreaterThan(0);
    expect(new Uint8Array(served)).toEqual(new Uint8Array(original));
  });

  it('serves a different icon on stage than in production', async () => {
    const [stage, production] = await Promise.all([
      fetchApi('/brand/apple-touch-icon.png', bindings('stage')).then((response) => response.arrayBuffer()),
      fetchApi('/brand/apple-touch-icon.png', bindings('production')).then((response) => response.arrayBuffer()),
    ]);

    expect(new Uint8Array(stage)).not.toEqual(new Uint8Array(production));
  });

  it('answers 404 for any other /brand path, never the app shell', async () => {
    const response = await SELF.fetch(`${ORIGIN}/brand/icon-512.png`);

    expect(response.status).toBe(404);
    expect(response.headers.get('content-type')).not.toContain('text/html');
  });
});
