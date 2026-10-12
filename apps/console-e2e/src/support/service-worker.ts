import { expect, type BrowserContext, type Page, type Route } from '@playwright/test';
import { createHash } from 'node:crypto';
import {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { extname, join, normalize, sep } from 'node:path';
import { STACKS_DIR, WORKSPACE_ROOT } from '../stack/local-stack';

/** What the local stack serves: build A, the version a device has installed. */
const BUILT_CONSOLE = join(WORKSPACE_ROOT, 'dist/apps/console/browser');
/** `<meta name=…>` that build B's shell carries, so a spec can tell which build a page runs. */
export const BUILD_MARKER = 'tc-e2e-build';

/**
 * Opens `path` and waits until Angular's service worker controls the page. Specs that need it opt in with
 * `test.use({ serviceWorkers: 'allow' })` (the suite blocks workers, playwright.config.ts).
 */
export async function underServiceWorker(page: Page, path: string): Promise<void> {
  await page.goto(path);
  await page.evaluate(async () => {
    await navigator.serviceWorker.ready;
  });
  // The worker claims the page once it activates; until then it would not see the page's requests at all.
  await page.waitForFunction(() => navigator.serviceWorker.controller !== null);
}

/** The files of build A that ngsw prefetches into its `app` group: the version is installed once all are cached. */
function prefetchedUrls(): string[] {
  const manifest: unknown = JSON.parse(readFileSync(join(BUILT_CONSOLE, 'ngsw.json'), 'utf8'));
  if (!isNgswManifest(manifest)) {
    throw new Error('dist/apps/console/browser/ngsw.json is not an ngsw manifest');
  }
  return manifest.assetGroups[0]?.urls ?? [];
}

/**
 * The app as a device runs it once installed: build A fully in the worker's caches, and the page loaded through the
 * worker, so the worker counts it as a client of that version and tells it about new ones.
 */
export async function openInstalled(page: Page, path: string): Promise<void> {
  await underServiceWorker(page, path);
  const urls = prefetchedUrls();
  await expect
    .poll(
      () =>
        page.evaluate(async (wanted) => {
          const cached = new Set<string>();
          for (const name of await caches.keys()) {
            if (name.endsWith(':assets:app:cache')) {
              for (const request of await (await caches.open(name)).keys()) {
                cached.add(new URL(request.url).pathname);
              }
            }
          }
          return wanted.filter((url) => !cached.has(url));
        }, urls),
      { message: 'build A is not fully installed', timeout: 30_000 },
    )
    .toEqual([]);
  await page.reload();
  await page.waitForFunction(() => navigator.serviceWorker.controller !== null);
}

interface NgswManifest {
  timestamp: number;
  assetGroups: { urls: string[] }[];
  hashTable: Record<string, string>;
}

function isNgswManifest(value: unknown): value is NgswManifest {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const manifest = value as Partial<NgswManifest>;
  return (
    typeof manifest.timestamp === 'number' &&
    Array.isArray(manifest.assetGroups) &&
    typeof manifest.hashTable === 'object' &&
    manifest.hashTable !== null
  );
}

/**
 * Build B: the built console as the next deploy differs from it. Every lazy chunk has a new name (so the installed
 * version's chunks are gone from the server, as after a real deploy), the shell carries `BUILD_MARKER`, and ngsw.json
 * lists and hashes it all the way the Angular CLI does (SHA-1 of the bytes served).
 */
export function writeNextBuild(name: string): string {
  const dir = join(STACKS_DIR, name, 'build-b');
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  cpSync(BUILT_CONSOLE, dir, { recursive: true });

  const renames = new Map(
    readdirSync(dir)
      .filter((file) => /^chunk-[^/]+\.js$/.test(file))
      .map((file) => [file, file.replace(/^chunk-/, 'chunk-next-')] as const),
  );
  for (const file of readdirSync(dir).filter((entry) => /\.(js|html)$/.test(entry))) {
    let text = readFileSync(join(dir, file), 'utf8');
    for (const [from, to] of renames) {
      text = text.replaceAll(from, to);
    }
    if (file === 'index.html') {
      text = text.replace('<head>', `<head>\n  <meta name="${BUILD_MARKER}" content="B">`);
    }
    const target = renames.get(file) ?? file;
    writeFileSync(join(dir, target), text);
    if (target !== file) {
      rmSync(join(dir, file));
    }
  }

  const manifest: unknown = JSON.parse(readFileSync(join(dir, 'ngsw.json'), 'utf8'));
  if (!isNgswManifest(manifest)) {
    throw new Error('dist/apps/console/browser/ngsw.json is not an ngsw manifest');
  }
  const renamed = (url: string): string => `/${renames.get(url.slice(1)) ?? url.slice(1)}`;
  const sha1 = (url: string): string =>
    createHash('sha1')
      .update(readFileSync(join(dir, url)))
      .digest('hex');
  manifest.timestamp = Date.now();
  for (const group of manifest.assetGroups) {
    group.urls = group.urls.map(renamed);
  }
  manifest.hashTable = Object.fromEntries(
    Object.keys(manifest.hashTable).map((url) => [renamed(url), sha1(renamed(url))]),
  );
  writeFileSync(join(dir, 'ngsw.json'), JSON.stringify(manifest, null, 2));
  return dir;
}

const CONTENT_TYPES: Readonly<Record<string, string>> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.svg': 'image/svg+xml',
};

/** Paths the api Worker answers itself, in every build alike. */
function isWorkerPath(pathname: string): boolean {
  return (
    pathname === '/api' ||
    pathname.startsWith('/api/') ||
    pathname === '/manifest.webmanifest' ||
    pathname.startsWith('/brand/') ||
    pathname.startsWith('/cdn-cgi/')
  );
}

/** The file of `dir` the assets layer would answer `pathname` with: the file, the shell for a route, or none. */
function fileFor(dir: string, pathname: string): string | null {
  if (pathname === '/' || pathname === '/index.html' || extname(pathname) === '') {
    return join(dir, 'index.html');
  }
  const file = normalize(join(dir, decodeURIComponent(pathname)));
  if (!file.startsWith(dir + sep) || !existsSync(file) || !statSync(file).isFile()) {
    return null;
  }
  return file;
}

export interface Deploys {
  /** From now on the origin serves build B, as after `wrangler deploy`; the api stays the same. */
  deployNext(): void;
}

/**
 * Serves the console's static files from `nextBuild` once `deployNext()` is called; until then the stack's own
 * build A. `context.route` also sees the service worker's fetches (ngsw.json, prefetching, cache-busted retries).
 */
export async function routeDeploys(
  context: BrowserContext,
  origin: string,
  nextBuild: string,
): Promise<Deploys> {
  let isNextDeployed = false;
  await context.route(
    (url) => url.origin === origin && !isWorkerPath(url.pathname),
    async (route: Route) => {
      if (!isNextDeployed) {
        await route.fallback();
        return;
      }
      const file = fileFor(nextBuild, new URL(route.request().url()).pathname);
      if (file === null) {
        await route.fulfill({ status: 404, contentType: 'text/plain', body: 'Not Found' });
        return;
      }
      await route.fulfill({
        status: 200,
        contentType: CONTENT_TYPES[extname(file)] ?? 'application/octet-stream',
        headers: { 'Cache-Control': 'no-cache' },
        body: readFileSync(file),
      });
    },
  );
  return {
    deployNext: () => {
      isNextDeployed = true;
    },
  };
}

/** The owner switches to another app and back: `visibilitychange` to hidden, then to visible. */
export async function leaveAndReturn(page: Page): Promise<void> {
  await page.evaluate(() => {
    for (const state of ['hidden', 'visible'] as const) {
      Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => state });
      document.dispatchEvent(new Event('visibilitychange'));
    }
  });
}
