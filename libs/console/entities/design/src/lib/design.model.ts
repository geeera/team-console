import {
  designFileUrlOf,
  isCommitSha,
  isDesignDevice,
  isDesignImageType,
  isGitHubPageUrl,
  type DesignDevice,
  type DesignInteractiveDto,
  type DesignManifestDto,
  type DesignScreenDto,
} from '@shared/contracts';

export type DesignManifest = DesignManifestDto;
export type DesignScreen = DesignScreenDto;

type JsonRecord = Readonly<Record<string, unknown>>;

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isRepoPath(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.startsWith('docs/design/') &&
    value.split('/').every((segment) => segment !== '' && segment !== '.' && segment !== '..')
  );
}

function isScreen(value: unknown): value is DesignScreenDto {
  return (
    isRecord(value) &&
    isRepoPath(value['path']) &&
    typeof value['file'] === 'string' &&
    typeof value['caption'] === 'string' &&
    (value['device'] === null || isDesignDevice(value['device'])) &&
    isDesignImageType(value['type']) &&
    typeof value['size'] === 'number' &&
    typeof value['tooLarge'] === 'boolean' &&
    isGitHubPageUrl(value['url'])
  );
}

function isInteractive(value: unknown): value is DesignInteractiveDto {
  return (
    isRecord(value) &&
    isRepoPath(value['path']) &&
    typeof value['url'] === 'string' &&
    URL.canParse(value['url']) &&
    new URL(value['url']).protocol === 'https:'
  );
}

/**
 * The checked manifest, or `null` when the body is not the read model's shape. A screen that fails the check (a path
 * outside docs/design, a type this build does not serve) is left out rather than failing the whole manifest.
 */
export function designManifestOf(body: unknown): DesignManifest | null {
  if (
    !isRecord(body) ||
    typeof body['issue'] !== 'number' ||
    !isCommitSha(body['sha']) ||
    (body['ref'] !== 'pull-request' && body['ref'] !== 'default-branch') ||
    !Array.isArray(body['screens']) ||
    typeof body['partial'] !== 'boolean' ||
    (body['interactive'] !== null && !isInteractive(body['interactive']))
  ) {
    return null;
  }
  return {
    issue: body['issue'],
    sha: body['sha'],
    ref: body['ref'],
    screens: body['screens'].filter(isScreen),
    interactive: body['interactive'],
    partial: body['partial'],
  };
}

/** The devices the screens were drawn for, in the order the device control shows them. */
export function devicesOf(manifest: DesignManifest): readonly DesignDevice[] {
  const found = new Set(manifest.screens.flatMap((screen) => (screen.device === null ? [] : [screen.device])));
  return (['phone', 'mac'] as const).filter((device) => found.has(device));
}

/** The screens of one device; with `null` every screen, as when the design names no device. */
export function screensFor(manifest: DesignManifest, device: DesignDevice | null): readonly DesignScreen[] {
  return device === null ? manifest.screens : manifest.screens.filter((screen) => screen.device === device);
}

/**
 * The screens a preview can show, the phone's first (the owner decides on the phone), each group in file-name order;
 * a screen over the size cap has no image to show and is left out.
 */
export function previewScreensOf(manifest: DesignManifest): readonly DesignScreen[] {
  const shown = manifest.screens.filter((screen) => !screen.tooLarge);
  return [...shown.filter((screen) => screen.device === 'phone'), ...shown.filter((screen) => screen.device !== 'phone')];
}

/** The screen a list row shows: the first one that can be shown, preferring the phone's. */
export function thumbnailOf(manifest: DesignManifest): DesignScreen | null {
  return previewScreensOf(manifest)[0] ?? null;
}

/** The `<img src>` of a screen: the api Worker's file route, pinned to the manifest's commit. */
export function screenSrcOf(slug: string, manifest: DesignManifest, screen: DesignScreen): string {
  return designFileUrlOf(slug, manifest.issue, manifest.sha, screen.path);
}

/** Megabytes with one decimal, for the "too large" note. */
export function megabytesOf(bytes: number): number {
  return Math.round((bytes / (1024 * 1024)) * 10) / 10;
}
