import { DESIGN_IMAGE_MAX_BYTES, type DesignManifestDto } from '@shared/contracts';
import {
  designManifestOf,
  devicesOf,
  megabytesOf,
  previewScreensOf,
  screenSrcOf,
  screensFor,
  thumbnailOf,
  type DesignManifest,
} from './design.model';

const SHA = 'a'.repeat(40);

export function screen(file: string, extra: Partial<DesignManifestDto['screens'][number]> = {}) {
  return {
    path: `docs/design/277-viewer/${file}`,
    file,
    caption: file.replace(/\.\w+$/, ''),
    device: file.startsWith('phone-') ? ('phone' as const) : file.startsWith('mac-') ? ('mac' as const) : null,
    type: 'png' as const,
    size: 1000,
    tooLarge: false,
    url: `https://github.com/geeera/team-console/blob/${SHA}/docs/design/277-viewer/${file}`,
    ...extra,
  };
}

export const MANIFEST: DesignManifest = {
  issue: 277,
  sha: SHA,
  ref: 'pull-request',
  screens: [screen('mac-01-list.png'), screen('phone-01-list.png'), screen('phone-02-grid.png')],
  interactive: {
    path: 'docs/design/277-viewer/wireframe.html',
    url: 'https://geeera.github.io/team-console/277-viewer/wireframe.html',
  },
  partial: false,
};

describe('designManifestOf', () => {
  it('accepts the manifest shape and drops a screen outside docs/design or of an unserved type', () => {
    const checked = designManifestOf({
      ...MANIFEST,
      screens: [
        ...MANIFEST.screens,
        screen('x.png', { path: 'docs/other/x.png' }),
        screen('y.svg', { type: 'svg' as 'png' }),
        screen('z.png', { url: 'javascript:alert(1)' }),
        { not: 'a screen' },
      ],
    });
    expect(checked).toEqual(MANIFEST);
  });

  it.each([
    ['no sha', { ...MANIFEST, sha: 'dev' }],
    ['an unknown ref', { ...MANIFEST, ref: 'tag' }],
    ['screens that are not a list', { ...MANIFEST, screens: {} }],
    ['an interactive url that is not https', { ...MANIFEST, interactive: { ...MANIFEST.interactive, url: 'http://x' } }],
    ['an interactive path outside docs/design', { ...MANIFEST, interactive: { ...MANIFEST.interactive, path: 'x.html' } }],
    ['null', null],
  ])('refuses a body with %s', (_label, body) => {
    expect(designManifestOf(body)).toBeNull();
  });
});

describe('the manifest helpers', () => {
  it('lists the devices in phone, mac order and filters screens by device', () => {
    expect(devicesOf(MANIFEST)).toEqual(['phone', 'mac']);
    expect(screensFor(MANIFEST, 'phone').map((s) => s.file)).toEqual(['phone-01-list.png', 'phone-02-grid.png']);
    expect(screensFor(MANIFEST, null)).toHaveLength(3);
    expect(devicesOf({ ...MANIFEST, screens: [screen('01-cover.png')] })).toEqual([]);
  });

  it('picks the thumbnail: the first phone screen that is not too large, else the first shown screen', () => {
    expect(thumbnailOf(MANIFEST)?.file).toBe('phone-01-list.png');
    const huge = { ...MANIFEST, screens: [screen('phone-01.png', { tooLarge: true }), screen('mac-01.png')] };
    expect(thumbnailOf(huge)?.file).toBe('mac-01.png');
    expect(thumbnailOf({ ...MANIFEST, screens: [] })).toBeNull();
  });

  it('lists the preview screens phone first, each group in file order, without the ones too large to show', () => {
    expect(previewScreensOf(MANIFEST).map((s) => s.file)).toEqual([
      'phone-01-list.png',
      'phone-02-grid.png',
      'mac-01-list.png',
    ]);
    const mixed = {
      ...MANIFEST,
      screens: [screen('01-cover.png'), screen('mac-01.png'), screen('phone-01.png', { tooLarge: true })],
    };
    expect(previewScreensOf(mixed).map((s) => s.file)).toEqual(['01-cover.png', 'mac-01.png']);
    expect(previewScreensOf({ ...MANIFEST, screens: [] })).toEqual([]);
  });

  it('builds the image source from the file route, pinned to the commit', () => {
    expect(screenSrcOf('team-console', MANIFEST, MANIFEST.screens[1] as DesignManifest['screens'][number])).toBe(
      `/api/v1/projects/team-console/designs/277/${SHA}/file?path=docs%2Fdesign%2F277-viewer%2Fphone-01-list.png`,
    );
  });

  it('rounds megabytes to one decimal', () => {
    expect(megabytesOf(DESIGN_IMAGE_MAX_BYTES)).toBe(5);
    expect(megabytesOf(12_582_912)).toBe(12);
    expect(megabytesOf(1_200_000)).toBe(1.1);
  });
});
