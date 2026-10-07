import { TestBed } from '@angular/core/testing';
import { provideServiceWorker, SwRegistrationOptions } from '@angular/service-worker';
import { appIconDirOf, ENVIRONMENTS } from '@shared/contracts';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { serviceWorkerOptions } from './pwa';

const appRoot = join(import.meta.dirname, '..', '..');

function readJson(relativePath: string): unknown {
  return JSON.parse(readFileSync(join(appRoot, relativePath), 'utf8'));
}

interface NgswGroup {
  name: string;
  resources?: { files?: string[]; urls?: string[] };
  urls?: string[];
}

interface NgswConfig {
  index: string;
  assetGroups?: NgswGroup[];
  dataGroups?: NgswGroup[];
  navigationUrls?: string[];
}

// The manifest itself is built per environment by the api Worker (#237, apps/api/src/routes/app-identity.spec.ts);
// what the build must ship is every environment's icon set it points at.
describe('icon sets', () => {
  it.each(ENVIRONMENTS)('ships the %s icons the manifest and /brand/* serve', (environment) => {
    for (const file of ['icon-192.png', 'icon-512.png', 'apple-touch-icon.png', 'favicon.ico']) {
      expect(() => readFileSync(join(appRoot, 'public', appIconDirOf(environment), file))).not.toThrow();
    }
  });

  it('has no static manifest or root favicon that would shadow what the Worker answers', () => {
    expect(existsSync(join(appRoot, 'public/manifest.webmanifest'))).toBe(false);
    expect(existsSync(join(appRoot, 'public/favicon.ico'))).toBe(false);
  });
});

describe('index.html', () => {
  const html = readFileSync(join(appRoot, 'src/index.html'), 'utf8');

  it('links the manifest (with the Access cookie) and the per-environment icons the Worker answers', () => {
    expect(html).toMatch(/<link rel="manifest" href="manifest\.webmanifest" crossorigin="use-credentials"/);
    expect(html).toMatch(/<link rel="icon" type="image\/x-icon" href="brand\/favicon\.ico"/);
    expect(html).toMatch(/<link rel="apple-touch-icon" sizes="180x180" href="brand\/apple-touch-icon\.png"/);
  });

  it('carries the iOS Home Screen meta tags', () => {
    expect(html).toContain('<meta name="apple-mobile-web-app-capable" content="yes"');
    expect(html).toContain('<meta name="apple-mobile-web-app-title"');
    expect(html).toContain('<meta name="apple-mobile-web-app-status-bar-style"');
    expect(html).toMatch(/<meta name="viewport" content="[^"]*viewport-fit=cover/);
  });
});

describe('ngsw-config.json', () => {
  const config = readJson('ngsw-config.json') as NgswConfig;

  it('prefetches the app shell and lazy-loads the rest', () => {
    expect(config.index).toBe('/index.html');
    expect(config.assetGroups?.map((group) => group.name)).toEqual(['app', 'assets']);
  });

  it('never caches /api', () => {
    const patterns = [...(config.assetGroups ?? []), ...(config.dataGroups ?? [])].flatMap((group) => [
      ...(group.resources?.files ?? []),
      ...(group.resources?.urls ?? []),
      ...(group.urls ?? []),
    ]);

    expect(patterns.length).toBeGreaterThan(0);
    for (const pattern of patterns) {
      expect(pattern, `${pattern} would match /api/`).not.toMatch(/(^|\/)api(\/|$)/);
      expect(pattern, `${pattern} is a catch-all that would swallow /api/`).not.toMatch(
        /^\/\*\*$|^\/\*\*\/\*$/,
      );
    }
    expect(config.dataGroups ?? []).toEqual([]);
  });

  it('never hashes what the Worker answers per environment, or a dev or stage install would fail its hash check', () => {
    const files = (config.assetGroups ?? []).flatMap((group) => group.resources?.files ?? []);

    for (const path of ['/manifest.webmanifest', '/favicon.ico', '/brand/*', '/brand/**']) {
      expect(files).not.toContain(path);
    }
  });

  it('keeps /api out of the navigation fallback', () => {
    expect(config.navigationUrls).toContain('!/api/**');
  });
});

describe('service worker registration', () => {
  it('is enabled only for production builds and waits for stability', () => {
    expect(serviceWorkerOptions(true)).toEqual({
      enabled: true,
      registrationStrategy: 'registerWhenStable:30000',
    });
    expect(serviceWorkerOptions(false).enabled).toBe(false);
  });

  it('reaches the Angular service-worker provider unchanged', () => {
    TestBed.configureTestingModule({
      providers: [provideServiceWorker('ngsw-worker.js', serviceWorkerOptions(true))],
    });

    const options = TestBed.inject(SwRegistrationOptions);
    expect(options.enabled).toBe(true);
    expect(options.registrationStrategy).toBe('registerWhenStable:30000');
  });
});
