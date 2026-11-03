import { Hono } from 'hono';
import {
  appIconDirOf,
  appNameOf,
  appShortNameOf,
  isEnvironment,
  type Environment,
} from '@shared/contracts';
import { problem, type WorkerContext, type WorkerHonoEnv } from '@worker/core';
import type { ApiEnv } from '../env';

/**
 * The install identity per environment (#237): one console build serves every environment, so the parts of it that
 * name or draw the app are answered here from `ENVIRONMENT` instead of being static files. `run_worker_first` in
 * wrangler.jsonc routes these paths to the Worker. None of them is in ngsw.json, so the service worker never
 * compares them with a build-time hash; the per-environment icon files they point to are static and hashed.
 */
export const MANIFEST_PATH = '/manifest.webmanifest';
/** Icons index.html links to; each answers the environment's copy from `apps/console/public/icons/<env>/`. */
export const BRAND_ICONS = ['favicon.ico', 'apple-touch-icon.png'] as const;

// Icons only change with a deploy; an hour keeps tab reloads off the Worker without pinning a stale icon for long.
const ICON_CACHE_CONTROL = 'public, max-age=3600';

export interface WebAppManifest {
  readonly name: string;
  readonly short_name: string;
  readonly description: string;
  readonly lang: string;
  readonly start_url: string;
  readonly scope: string;
  readonly display: string;
  readonly orientation: string;
  readonly background_color: string;
  readonly theme_color: string;
  readonly icons: readonly { src: string; sizes: string; type: string; purpose: string }[];
}

/** The web app manifest; production's names and colours are those of the static file it replaces. */
export function webManifestOf(environment: Environment): WebAppManifest {
  const icons = appIconDirOf(environment);
  return {
    name: appNameOf(environment),
    short_name: appShortNameOf(environment),
    description: 'Control panel for the product team: questions, PM chat, sprint board, designs.',
    lang: 'ru',
    start_url: '/',
    scope: '/',
    display: 'standalone',
    orientation: 'portrait',
    // The manifest is JSON, outside the design-token CSS: these are --bg and --accent of the light palette.
    background_color: '#f7f3ec',
    theme_color: '#3e6a48',
    icons: [
      { src: `${icons}/icon-192.png`, sizes: '192x192', type: 'image/png', purpose: 'any' },
      { src: `${icons}/icon-512.png`, sizes: '512x512', type: 'image/png', purpose: 'any' },
      { src: `${icons}/icon-512.png`, sizes: '512x512', type: 'image/png', purpose: 'maskable' },
      { src: `${icons}/apple-touch-icon.png`, sizes: '180x180', type: 'image/png', purpose: 'any' },
    ],
  };
}

function environmentOf(c: WorkerContext<ApiEnv>): Environment | Response {
  const environment: string = c.env.ENVIRONMENT;
  if (!isEnvironment(environment)) {
    return problem(c, {
      type: 'misconfigured',
      title: 'ENVIRONMENT is not one of local, dev, stage, production',
      status: 500,
    });
  }
  return environment;
}

export const appIdentityRoutes = new Hono<WorkerHonoEnv<ApiEnv>>();

appIdentityRoutes.get(MANIFEST_PATH, (c) => {
  const environment = environmentOf(c);
  if (environment instanceof Response) {
    return environment;
  }
  // Revalidated on every launch check, so a deploy's name or icon change reaches the browser's next update check.
  c.header('Cache-Control', 'no-cache');
  return c.body(JSON.stringify(webManifestOf(environment)), 200, {
    'Content-Type': 'application/manifest+json; charset=utf-8',
  });
});

for (const icon of BRAND_ICONS) {
  appIdentityRoutes.get(`/brand/${icon}`, async (c) => {
    const environment = environmentOf(c);
    if (environment instanceof Response) {
      return environment;
    }
    const url = new URL(`${appIconDirOf(environment)}/${icon}`, c.req.url);
    const asset = await c.env.ASSETS.fetch(new Request(url, { method: 'GET', headers: c.req.raw.headers }));
    // The assets layer answers a missing file with the SPA shell (200, text/html): only an image counts.
    const isImage = asset.headers.get('Content-Type')?.startsWith('image/') === true;
    if (asset.status !== 304 && !(asset.ok && isImage)) {
      return problem(c, { type: 'not-found', title: 'Not Found', status: 404 });
    }
    // A fetched response's headers are immutable; the copy takes the Worker's nosniff and deny-all CSP like any
    // response it builds — an image needs nothing the console's page policy allows.
    const response = new Response(asset.body, asset);
    response.headers.set('Cache-Control', ICON_CACHE_CONTROL);
    return response;
  });
}

// run_worker_first sends all of /brand/* here; anything else under it is a 404, never the SPA shell.
appIdentityRoutes.all('/brand/*', (c) => problem(c, { type: 'not-found', title: 'Not Found', status: 404 }));
