import snapshot from '../../../fixtures/artifacts-team-console.json';
import { isGitHubIssue, issueRecordOf, type IssueRecord } from '../github-records';
import { contentsEntriesOf, contentsFileTextOf, type ContentsEntry } from './common';
import { DECISION_TITLE_READS, decisionArtifactsOf, decisionFilesOf, firstHeadingOf } from './decisions';
import { demoArtifactsOf } from './demo';
import { designArtifactsOf } from './designs';

// #19 read models over a snapshot of geeera/team-console's own GitHub answers (fixtures/artifacts_snapshot.py).

function issuesOf(raw: readonly unknown[]): IssueRecord[] {
  return raw.filter(isGitHubIssue).map(issueRecordOf);
}

function entry(name: string, extra: Partial<ContentsEntry> = {}): ContentsEntry {
  return {
    name,
    path: `docs/decisions/${name}`,
    kind: 'file',
    htmlUrl: `https://github.com/o/r/blob/main/docs/decisions/${name}`,
    ...extra,
  };
}

describe('the artifacts of geeera/team-console (snapshot)', () => {
  const decisionFiles = decisionFilesOf(contentsEntriesOf(snapshot.decisions));
  const titles = new Map(
    Object.entries(snapshot.decisionFirstLines).map(([path, line]) => [path, firstHeadingOf(line)]),
  );
  const decisions = decisionArtifactsOf(decisionFiles, titles);
  // #770: every file under docs/design, as one Git tree read now answers it — the fixture still models it as
  // Contents entries (the root plus every sub-folder, not just the first five) since `designArtifactsOf` only
  // cares about the entry shape, not which GitHub API produced it.
  const designFiles = [
    ...contentsEntriesOf(snapshot.designRoot),
    ...Object.values(snapshot.designFolders as Record<string, unknown[]>).flatMap((entries) =>
      contentsEntriesOf(entries),
    ),
  ];
  const designs = designArtifactsOf({
    issues: issuesOf(Object.values(snapshot.designIssues).flat()),
    files: designFiles,
    storybookUrl: null,
      issuesBaseUrl: 'https://github.com/o/r/issues/',
  });
  const demos = demoArtifactsOf(issuesOf(snapshot.demoIssues));

  it('finds every decision record, newest first, titled by its heading', () => {
    expect(decisions.map((item) => item.title)).toEqual([
      "0003 — The console's GitHub identity: a GitHub App per environment, owner writes on the owner's own token",
      'ADR 0002: Visual direction — Paper Desk',
      '0001 — Stack and architecture',
    ]);
    expect(
      decisions.every((item) => item.url.startsWith('https://github.com/geeera/team-console/blob/')),
    ).toBe(true);
  });

  it('finds every design: each labelled issue once, the wireframes and notes, no generator sources', () => {
    const issues = designs.filter((item) => item.source === 'issue');
    const files = designs.filter((item) => item.source === 'file');
    // The hand-made count: 15 distinct issues under ux-spec / design:* and 10 files in docs/design and its folders.
    expect(issues).toHaveLength(15);
    expect(new Set(issues.map((item) => item.url)).size).toBe(15);
    expect(files.map((item) => item.title)).toEqual([
      'directions/01-paper-desk.html',
      'directions/02-switchboard.html',
      'directions/03-signal.html',
      'directions/README.md',
      'features/114-team-commands.html',
      'features/134-board-phone-lanes.html',
      'features/24-settings-projects.html',
      'features/36-web-push.html',
      'features/README.md',
      'references.md',
    ]);
  });

  it('adds a regression fixture with more than five design sub-folders, all still listed (#770)', () => {
    const manyFolders = [
      ...snapshot.designRoot,
      ...Array.from({ length: 7 }, (_, index) => ({
        name: `${index + 1}-x.html`,
        path: `docs/design/extra-${index + 1}/${index + 1}-x.html`,
        type: 'file',
        html_url: `https://github.com/geeera/team-console/blob/dev/docs/design/extra-${index + 1}/${index + 1}-x.html`,
      })),
    ];
    const files = designArtifactsOf({
      issues: [],
      files: contentsEntriesOf(manyFolders),
      storybookUrl: null,
      issuesBaseUrl: 'https://github.com/o/r/issues/',
    }).filter((item) => item.source === 'file');
    // Seven extra folders is well past the old DESIGN_SUBFOLDER_READS cap of 5; every one of them is listed.
    expect(files.filter((item) => item.title.startsWith('extra-'))).toHaveLength(7);
  });

  it('reports no design file as a generator source unless a `src` segment is in its path', () => {
    const htmlUrl = (path: string) => `https://github.com/o/r/blob/main/${path}`;
    const files = designArtifactsOf({
      issues: [],
      files: contentsEntriesOf([
        {
          name: 'build.html',
          path: 'docs/design/277-viewer/src/build.html',
          type: 'file',
          html_url: htmlUrl('docs/design/277-viewer/src/build.html'),
        },
        {
          name: 'index.html',
          path: 'docs/design/277-viewer/index.html',
          type: 'file',
          html_url: htmlUrl('docs/design/277-viewer/index.html'),
        },
      ]),
      storybookUrl: null,
      issuesBaseUrl: 'https://github.com/o/r/issues/',
    }).filter((item) => item.source === 'file');
    expect(files.map((item) => item.title)).toEqual(['277-viewer/index.html']);
  });

  it('finds the demo issue and links to the issue itself', () => {
    expect(demos).toEqual([
      {
        type: 'demo',
        title: 'Sprint 1 demo',
        url: 'https://github.com/geeera/team-console/issues/900001',
        updatedAt: '2026-10-02T09:00:00Z',
        source: 'issue',
        state: 'closed',
      },
    ]);
  });
});

describe('decision files', () => {
  it('keeps Markdown files with a github.com page, without README, sorted by name descending', () => {
    const files = decisionFilesOf([
      entry('0001-a.md'),
      entry('README.md'),
      entry('0010-b.MD'),
      entry('notes.txt'),
      entry('0002-c.md', { htmlUrl: null }),
      entry('drafts', { kind: 'dir' }),
    ]);
    expect(files.map((file) => file.name)).toEqual(['0010-b.MD', '0001-a.md']);
  });

  it('falls back to the file name when a title was not read', () => {
    const [artifact] = decisionArtifactsOf(
      [entry('0004-x.md')],
      new Map([['docs/decisions/0004-x.md', null]]),
    );
    expect(artifact?.title).toBe('0004-x');
  });

  it('bounds the title reads below the 50-subrequest cap', () => {
    expect(DECISION_TITLE_READS).toBeLessThanOrEqual(30);
  });
});

describe('firstHeadingOf', () => {
  it('reads the first level-1 heading and strips closing hashes', () => {
    expect(firstHeadingOf('intro\n## sub\n# Title here ##\n# second')).toBe('Title here');
  });

  it('skips headings inside a code fence and returns null without one', () => {
    expect(firstHeadingOf('```\n# not a title\n```\n# Real')).toBe('Real');
    expect(firstHeadingOf('no heading\n#hashtag')).toBeNull();
  });

  it('keeps markup as text (it is rendered as plain text) and caps the length', () => {
    expect(firstHeadingOf('# <img src=x onerror=alert(1)>')).toBe('<img src=x onerror=alert(1)>');
    expect(firstHeadingOf(`# ${'x'.repeat(500)}`)).toHaveLength(200);
  });
});

describe('contents answers', () => {
  it('decodes a base64 file answer and refuses anything else', () => {
    const content = btoa(String.fromCharCode(...new TextEncoder().encode('# Решение')));
    expect(contentsFileTextOf({ type: 'file', encoding: 'base64', content })).toBe('# Решение');
    expect(contentsFileTextOf({ type: 'file', encoding: 'none', content: '' })).toBeNull();
    expect(contentsFileTextOf({ type: 'file', encoding: 'base64', content: '***' })).toBeNull();
    expect(contentsFileTextOf([])).toBeNull();
  });

  it('drops a non-github.com page and skips malformed entries', () => {
    const entries = contentsEntriesOf([
      { name: 'a.md', path: 'd/a.md', type: 'file', html_url: 'javascript:alert(1)' },
      { name: 7 },
      'x',
    ]);
    expect(entries).toEqual([{ name: 'a.md', path: 'd/a.md', kind: 'file', htmlUrl: null }]);
  });
});

describe('design and demo issues', () => {
  const base = {
    title: 'T',
    body: '',
    state: 'open',
    author_association: 'OWNER',
    user: { login: 'geeera', type: 'User' },
  };

  it('drops pull requests, foreign urls and unlabelled issues; keeps a link from project.yml', () => {
    const issues = issuesOf([
      { ...base, number: 1, labels: [{ name: 'ux-spec' }], html_url: 'https://github.com/o/r/issues/1' },
      { ...base, number: 2, labels: [{ name: 'ux-spec' }], html_url: 'javascript:alert(1)' },
      {
        ...base,
        number: 3,
        labels: [{ name: 'design:approved' }],
        html_url: 'https://github.com/o/r/pull/3',
        pull_request: {},
      },
      { ...base, number: 4, labels: [{ name: 'kind:feature' }], html_url: 'https://github.com/o/r/issues/4' },
    ]);
    const designs = designArtifactsOf({
      issues,
      files: [],
      storybookUrl: 'https://github.com/o/r/tree/main/storybook',
      issuesBaseUrl: 'https://github.com/o/r/issues/',
    });
    expect(designs.map((item) => [item.source, item.url])).toEqual([
      ['issue', 'https://github.com/o/r/issues/1'],
      ['config', 'https://github.com/o/r/tree/main/storybook'],
    ]);
  });

  it('counts an unlabelled issue with a docs/design N-* folder, once, without a per-issue read (#771)', () => {
    const file = (path: string) => ({
      name: path.split('/').pop() ?? path,
      path,
      kind: 'file' as const,
      htmlUrl: `https://github.com/o/r/blob/sha/${path}`,
    });
    const designs = designArtifactsOf({
      issues: issuesOf([
        { ...base, number: 1, labels: [{ name: 'ux-spec' }], html_url: 'https://github.com/o/r/issues/1' },
      ]),
      files: [
        file('docs/design/688-agent-picker/a.html'),
        file('docs/design/688-agent-picker/b.html'),
        file('docs/design/features/24-settings/index.html'),
        file('docs/design/1-labelled/x.html'),
        file('docs/design/directions/01-paper-desk.html'),
        file('docs/design/277-viewer/src/3-build.js'),
      ],
      storybookUrl: null,
      issuesBaseUrl: 'https://github.com/o/r/issues/',
    });
    expect(
      designs.filter((item) => item.source === 'issue').map((item) => [item.number, item.title, item.url, item.state]),
    ).toEqual([
      [1, 'T', 'https://github.com/o/r/issues/1', 'open'],
      [688, 'agent picker', 'https://github.com/o/r/issues/688', null],
      [24, 'settings', 'https://github.com/o/r/issues/24', null],
    ]);
  });

  describe('folder rows (#855)', () => {
    const file = (path: string) => ({
      name: path.split('/').pop() ?? path,
      path,
      kind: 'file' as const,
      htmlUrl: `https://github.com/o/r/blob/sha/${path}`,
    });
    const rowsOf = (paths: string[], issues = issuesOf([]), issuesBaseUrl = 'https://github.com/o/r/issues/') =>
      designArtifactsOf({ issues, files: paths.map(file), storybookUrl: null, issuesBaseUrl })
        .filter((item) => item.source === 'issue')
        .map((item) => item.number);

    it('names an issue by a directory only, never by a file name', () => {
      expect(rowsOf(['docs/design/directions/3-col-layout.html', 'docs/design/7-note.md'])).toEqual([]);
    });

    it('skips a year-like or over-long number', () => {
      expect(
        rowsOf(['docs/design/2024-roadmap/a.html', 'docs/design/20240101-export/a.html', 'docs/design/12-ok/a.html']),
      ).toEqual([12]);
    });

    it('gives a folder of assets only no row', () => {
      expect(rowsOf(['docs/design/55-assets/phone.png', 'docs/design/55-assets/screens.json'])).toEqual([]);
      expect(rowsOf(['docs/design/55-assets/phone.png', 'docs/design/55-assets/wireframe.html'])).toEqual([55]);
    });

    it('builds the row link from the given base, however it looks', () => {
      const [row] = designArtifactsOf({
        issues: issuesOf([]),
        files: [file('docs/design/9-x/a.md')],
        storybookUrl: null,
        issuesBaseUrl: 'https://ghe.example/o/r/issues/',
      });
      expect(row?.url).toBe('https://ghe.example/o/r/issues/9');
    });

    it('lists a labelled issue once, not again from its folder', () => {
      const issues = issuesOf([
        { ...base, number: 9, labels: [{ name: 'ux-spec' }], html_url: 'https://github.com/o/r/issues/9' },
      ]);
      expect(rowsOf(['docs/design/9-x/a.html', 'docs/design/10-y/a.html'], issues)).toEqual([9, 10]);
    });
  });

  it('orders demos by the latest update', () => {
    const demos = demoArtifactsOf(
      issuesOf([
        {
          ...base,
          number: 1,
          labels: ['team:demo'],
          html_url: 'https://github.com/o/r/issues/1',
          updated_at: '2026-01-01T00:00:00Z',
        },
        {
          ...base,
          number: 2,
          labels: ['team:demo'],
          html_url: 'https://github.com/o/r/issues/2',
          updated_at: '2026-03-01T00:00:00Z',
        },
      ]),
    );
    expect(demos.map((item) => item.url)).toEqual([
      'https://github.com/o/r/issues/2',
      'https://github.com/o/r/issues/1',
    ]);
  });
});
