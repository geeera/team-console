import { DESIGN_FILE_LIMIT, DESIGN_IMAGE_MAX_BYTES } from '@shared/contracts';
import { isGitHubPullRequest, pullRequestRecordOf, type PullRequestRecord } from '../github-records';
import {
  captionOf,
  designFilesOf,
  designManifestOf,
  deviceOf,
  imageTypeOf,
  isGitHubTree,
  linkingPullRequestOf,
  pagesUrlOf,
  screenCaptionsOf,
  screensJsonOf,
  treeListingOf,
  type TreeEntry,
  type TreeListing,
} from './design-files';

const SHA = 'a'.repeat(40);
const REPO = { owner: 'geeera', name: 'team-console' };

function blob(path: string, size = 100, sha = 'b'.repeat(40)): TreeEntry {
  return { path, sha, size };
}

function listing(paths: readonly string[]): TreeListing {
  return { entries: paths.map((path) => blob(path)), truncated: false };
}

const OWN_REPO = 'geeera/team-console';

function pull(number: number, extra: Record<string, unknown> = {}): PullRequestRecord {
  const raw = {
    number,
    title: `PR ${number}`,
    html_url: `https://github.com/geeera/team-console/pull/${number}`,
    author_association: 'OWNER',
    user: { login: 'geeera', type: 'User' },
    head: { sha: SHA, ref: `feature/${number}-thing`, repo: { full_name: OWN_REPO } },
    ...extra,
  };
  if (!isGitHubPullRequest(raw)) {
    throw new Error('fixture is not a pull request');
  }
  return pullRequestRecordOf(raw);
}

describe('treeListingOf', () => {
  it('keeps blobs with a sha and a size, drops trees and odd items', () => {
    const answer = {
      sha: SHA,
      tree: [
        { path: 'docs', type: 'tree', sha: 'c'.repeat(40) },
        { path: 'docs/design/277-x/a.png', type: 'blob', sha: 'b'.repeat(40), size: 12 },
        { path: 'docs/design/277-x/no-sha.png', type: 'blob', size: 12 },
        { path: 'docs/design/277-x/bad-sha.png', type: 'blob', sha: 'zz', size: 12 },
        { path: 'docs/design/277-x/no-size.png', type: 'blob', sha: 'b'.repeat(40) },
        'junk',
      ],
      truncated: true,
    };
    expect(isGitHubTree(answer)).toBe(true);
    expect(treeListingOf(answer)).toEqual({
      entries: [{ path: 'docs/design/277-x/a.png', sha: 'b'.repeat(40), size: 12 }],
      truncated: true,
    });
  });

  it('refuses answers without a tree array', () => {
    expect(isGitHubTree({ sha: SHA })).toBe(false);
    expect(isGitHubTree({ tree: 'x' })).toBe(false);
    expect(isGitHubTree(null)).toBe(false);
  });
});

describe('designFilesOf', () => {
  it('lists the files of docs/design/N-slug/**, docs/design/*/N-slug.html and docs/design/*/N-slug/**, by path', () => {
    const tree = listing([
      'docs/design/features/277-viewer.html',
      'docs/design/277-design-viewer/phone-01-list.png',
      'docs/design/277-design-viewer/wireframe.html',
      'docs/design/ux/277-viewer/mac-01.png',
      'docs/design/2770-other/phone-01.png',
      'docs/design/features/27-other.html',
      'docs/design/277-design-viewer/src/build.py',
      'docs/design/277-design-viewer/src/277-template.html',
      'docs/other/277-not-design.png',
      'README.md',
    ]);
    expect(designFilesOf(tree, 277).files.map((file) => file.path)).toEqual([
      'docs/design/277-design-viewer/phone-01-list.png',
      'docs/design/277-design-viewer/wireframe.html',
      'docs/design/features/277-viewer.html',
      'docs/design/ux/277-viewer/mac-01.png',
    ]);
  });

  it('matches the issue number exactly: 27 is not 277 and 277 is not 2770', () => {
    const tree = listing(['docs/design/277-a/x.png', 'docs/design/27-b/x.png', 'docs/design/2770-c/x.png']);
    expect(designFilesOf(tree, 27).files.map((file) => file.path)).toEqual(['docs/design/27-b/x.png']);
    expect(designFilesOf(tree, 2770).files.map((file) => file.path)).toEqual(['docs/design/2770-c/x.png']);
  });

  it('refuses paths with empty, . or .. segments', () => {
    const tree = listing(['docs/design/277-a/../x.png', 'docs/design/277-a//x.png', 'docs/design/277-a/./x.png']);
    expect(designFilesOf(tree, 277).files).toEqual([]);
  });

  it(`keeps the first ${DESIGN_FILE_LIMIT} files and says the rest were cut`, () => {
    const paths = Array.from(
      { length: DESIGN_FILE_LIMIT + 1 },
      (_, index) => `docs/design/277-a/phone-${String(index).padStart(2, '0')}.png`,
    );
    const files = designFilesOf(listing(paths), 277);
    expect(files.files).toHaveLength(DESIGN_FILE_LIMIT);
    expect(files.partial).toBe(true);
    expect(designFilesOf(listing(paths.slice(0, 3)), 277).partial).toBe(false);
  });
});

describe('file names', () => {
  it.each([
    ['phone-01-list.png', 'png'],
    ['mac-02.JPG', 'jpeg'],
    ['a.jpeg', 'jpeg'],
    ['a.webp', 'webp'],
    ['a.gif', 'gif'],
    ['a.svg', null],
    ['a.html', null],
    ['a.png.svg', null],
    ['noext', null],
  ] as const)('%s is %s', (file, type) => {
    expect(imageTypeOf(file)).toBe(type);
  });

  it('reads the device from the prefix', () => {
    expect(deviceOf('phone-01-list.png')).toBe('phone');
    expect(deviceOf('mac-01-list.png')).toBe('mac');
    expect(deviceOf('01-list.png')).toBeNull();
    expect(deviceOf('phones.png')).toBeNull();
  });

  it('captions from the file name without the device and the order', () => {
    expect(captionOf('phone-01-loaded.png')).toBe('loaded');
    expect(captionOf('mac-02-all-screens.png')).toBe('all screens');
    expect(captionOf('03-board_lanes.webp')).toBe('board lanes');
    expect(captionOf('phone-01.png')).toBe('phone-01');
    expect(captionOf('cover.png')).toBe('cover');
  });
});

describe('screenCaptionsOf', () => {
  it('maps file names to trimmed titles and ignores bad entries', () => {
    const captions = screenCaptionsOf(
      JSON.stringify([
        { file: 'phone-01-loaded.png', title: '  Доска — загружено  ' },
        { file: 'phone-02.png', title: '' },
        { file: '../phone-03.png', title: 'escape' },
        { file: 'phone-04.png' },
        { title: 'no file' },
        'junk',
        { file: 'phone-05.png', title: 'x'.repeat(200) },
      ]),
    );
    expect([...captions.entries()]).toEqual([
      ['phone-01-loaded.png', 'Доска — загружено'],
      ['phone-05.png', 'x'.repeat(120)],
    ]);
  });

  it('gives no captions for anything that is not a JSON array', () => {
    expect(screenCaptionsOf('not json').size).toBe(0);
    expect(screenCaptionsOf('{"file":"a","title":"b"}').size).toBe(0);
  });

  it('finds a small screens.json among the files and skips a large one', () => {
    const small = blob('docs/design/277-a/screens.json', 300);
    expect(screensJsonOf([blob('docs/design/277-a/a.png'), small])).toBe(small);
    expect(screensJsonOf([blob('docs/design/277-a/screens.json', 1024 * 1024)])).toBeNull();
    expect(screensJsonOf([blob('docs/design/277-a/screens.json.bak')])).toBeNull();
  });
});

describe('designManifestOf', () => {
  it('lists images in order with captions, devices, github.com links and the size cap; HTML becomes interactive', () => {
    const files = designFilesOf(
      {
        entries: [
          blob('docs/design/277-a/phone-02-grid.png', 10),
          blob('docs/design/277-a/phone-01-list.png', DESIGN_IMAGE_MAX_BYTES + 1),
          blob('docs/design/277-a/mac-01 list.jpg', 20),
          blob('docs/design/277-a/wireframe.html'),
          blob('docs/design/277-a/notes.md'),
          blob('docs/design/277-a/logo.svg'),
          blob('docs/design/277-a/screens.json'),
          blob('docs/design/277-a/z-second.html'),
        ],
        truncated: false,
      },
      277,
    );
    const manifest = designManifestOf({
      issue: 277,
      sha: SHA,
      ref: 'pull-request',
      files,
      truncated: false,
      captions: new Map([['phone-02-grid.png', 'Все экраны']]),
      repo: REPO,
    });
    expect(manifest).toEqual({
      issue: 277,
      sha: SHA,
      ref: 'pull-request',
      partial: false,
      interactive: {
        path: 'docs/design/277-a/wireframe.html',
        url: 'https://geeera.github.io/team-console/277-a/wireframe.html',
      },
      screens: [
        {
          path: 'docs/design/277-a/mac-01 list.jpg',
          file: 'mac-01 list.jpg',
          caption: 'list',
          device: 'mac',
          type: 'jpeg',
          size: 20,
          tooLarge: false,
          url: `https://github.com/geeera/team-console/blob/${SHA}/docs/design/277-a/mac-01%20list.jpg`,
        },
        {
          path: 'docs/design/277-a/phone-01-list.png',
          file: 'phone-01-list.png',
          caption: 'list',
          device: 'phone',
          type: 'png',
          size: DESIGN_IMAGE_MAX_BYTES + 1,
          tooLarge: true,
          url: `https://github.com/geeera/team-console/blob/${SHA}/docs/design/277-a/phone-01-list.png`,
        },
        {
          path: 'docs/design/277-a/phone-02-grid.png',
          file: 'phone-02-grid.png',
          caption: 'Все экраны',
          device: 'phone',
          type: 'png',
          size: 10,
          tooLarge: false,
          url: `https://github.com/geeera/team-console/blob/${SHA}/docs/design/277-a/phone-02-grid.png`,
        },
      ],
    });
    // An SVG is never a screen, whatever its name says.
    expect(manifest.screens.some((screen) => screen.file.endsWith('.svg'))).toBe(false);
  });

  it('is partial when the files were cut or GitHub truncated the tree', () => {
    const base = { issue: 1, sha: SHA, ref: 'default-branch' as const, captions: new Map(), repo: REPO };
    expect(designManifestOf({ ...base, files: { files: [], partial: true }, truncated: false }).partial).toBe(true);
    expect(designManifestOf({ ...base, files: { files: [], partial: false }, truncated: true }).partial).toBe(true);
    expect(designManifestOf({ ...base, files: { files: [], partial: false }, truncated: false }).partial).toBe(false);
  });

  it('builds the Pages URL from the owner, the repository and the path under docs/design', () => {
    expect(pagesUrlOf({ owner: 'Geeera', name: 'team-console' }, 'docs/design/277-a/wire frame.html')).toBe(
      'https://geeera.github.io/team-console/277-a/wire%20frame.html',
    );
  });
});

describe('linkingPullRequestOf', () => {
  const head = (ref: string, repo: string = OWN_REPO) => ({ sha: SHA, ref, repo: { full_name: repo } });
  const find = (pulls: PullRequestRecord[], issue: number) => linkingPullRequestOf(pulls, issue, OWN_REPO);

  it('finds the newest open pull request that mentions #N in its body or title', () => {
    const pulls = [
      pull(3, { body: 'Closes #2770', head: head('docs/other') }),
      pull(2, { body: 'Wireframes for #277 and #276', head: head('docs/275-277-ux-specs') }),
      pull(1, { title: 'feat(#277): viewer', head: head('x') }),
    ];
    expect(find(pulls, 277)?.number).toBe(2);
    expect(find(pulls, 276)?.number).toBe(2);
    expect(find(pulls, 2770)?.number).toBe(3);
    expect(find(pulls, 27)).toBeNull();
  });

  it('matches a head branch segment starting with N-', () => {
    const pulls = [pull(5, { body: '', head: head('design/277-viewer') })];
    expect(find(pulls, 277)?.number).toBe(5);
    expect(find(pulls, 27)).toBeNull();
    expect(find([pull(6, { body: '', head: head('277-only') })], 277)?.number).toBe(6);
  });

  it('skips a pull request without a usable head sha', () => {
    expect(find([pull(7, { body: 'Closes #277', head: { sha: 'short', repo: { full_name: OWN_REPO } } })], 277)).toBeNull();
  });

  it("skips an outsider's pull request, whatever it says, and takes the team's one behind it", () => {
    const outsider = pull(9, {
      title: 'Fix #277',
      body: 'Closes #277',
      author_association: 'NONE',
      user: { login: 'someone', type: 'User' },
      head: head('design/277-viewer'),
    });
    const team = pull(8, { body: 'Closes #277', head: head('design/277-real') });
    expect(find([outsider, team], 277)?.number).toBe(8);
    expect(find([outsider], 277)).toBeNull();
    // A trusted bot of the team counts; an unknown bot does not.
    const teamBot = pull(10, {
      body: 'Closes #277',
      author_association: 'NONE',
      user: { login: 'team-console-team[bot]', type: 'Bot' },
    });
    const strangerBot = { ...teamBot, number: 11, authorLogin: 'stranger[bot]' };
    expect(find([strangerBot, teamBot], 277)?.number).toBe(10);
  });

  it('skips a pull request whose branch lives in a fork or in no repository, even from a trusted author', () => {
    const fork = pull(12, { body: 'Closes #277', head: head('design/277-viewer', 'someone/team-console') });
    const deletedFork = pull(13, { body: 'Closes #277', head: { sha: SHA, ref: 'design/277-viewer', repo: null } });
    const own = pull(14, { body: 'Closes #277', head: head('design/277-viewer', 'Geeera/Team-Console') });
    expect(find([fork, deletedFork, own], 277)?.number).toBe(14);
    expect(find([fork, deletedFork], 277)).toBeNull();
  });
});
