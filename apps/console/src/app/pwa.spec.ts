import { TestBed } from '@angular/core/testing';
import { provideServiceWorker, SwRegistrationOptions } from '@angular/service-worker';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { serviceWorkerOptions } from './pwa';

const appRoot = join(import.meta.dirname, '..', '..');

function readJson(relativePath: string): unknown {
  return JSON.parse(readFileSync(join(appRoot, relativePath), 'utf8'));
}

interface ManifestIcon {
  src: string;
  sizes: string;
  type: string;
  purpose?: string;
}

interface Manifest {
  name: string;
  short_name: string;
  start_url: string;
  display: string;
  lang: string;
  icons: ManifestIcon[];
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

describe('web manifest', () => {
  const manifest = readJson('public/manifest.webmanifest') as Manifest;

  it('installs as a standalone app from the root', () => {
    expect(manifest.display).toBe('standalone');
    expect(manifest.start_url).toBe('/');
    expect(manifest.lang).toBe('ru');
  });

  it('ships the 192 and 512 PNG icons Chrome requires', () => {
    const sizes = manifest.icons.filter((icon) => icon.type === 'image/png').map((icon) => icon.sizes);
    expect(sizes).toEqual(expect.arrayContaining(['192x192', '512x512']));
  });

  it('points every icon at a file that exists', () => {
    for (const icon of manifest.icons) {
      expect(() => readFileSync(join(appRoot, 'public', icon.src))).not.toThrow();
    }
  });
});

describe('index.html', () => {
  const html = readFileSync(join(appRoot, 'src/index.html'), 'utf8');

  it('links the manifest and the 180px Apple touch icon', () => {
    expect(html).toMatch(/<link rel="manifest" href="manifest\.webmanifest"/);
    expect(html).toMatch(/<link rel="apple-touch-icon" sizes="180x180" href="icons\/apple-touch-icon\.png"/);
    expect(() => readFileSync(join(appRoot, 'public/icons/apple-touch-icon.png'))).not.toThrow();
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
