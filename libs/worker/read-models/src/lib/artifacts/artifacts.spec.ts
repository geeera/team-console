import snapshot from '../../../fixtures/artifacts-team-console.json';
import { isGitHubIssue, issueRecordOf, type IssueRecord } from '../github-records';
import { contentsEntriesOf, contentsFileTextOf, type ContentsEntry } from './common';
import { DECISION_TITLE_READS, decisionArtifactsOf, decisionFilesOf, firstHeadingOf } from './decisions';
import { demoArtifactsOf } from './demo';
import { designArtifactsOf, designFoldersOf } from './designs';

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
  const folders = designFoldersOf(contentsEntriesOf(snapshot.designRoot));
  const designFiles = [
    ...contentsEntriesOf(snapshot.designRoot),
    ...folders.flatMap((folder) =>
      contentsEntriesOf((snapshot.designFolders as Record<string, unknown[]>)[folder.path] ?? []),
    ),
  ];
  const designs = designArtifactsOf({
    issues: issuesOf(Object.values(snapshot.designIssues).flat()),
    files: designFiles,
    storybookUrl: null,
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
    expect(folders.map((folder) => folder.name)).toEqual(['directions', 'features']);
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
    });
    expect(designs.map((item) => [item.source, item.url])).toEqual([
      ['issue', 'https://github.com/o/r/issues/1'],
      ['config', 'https://github.com/o/r/tree/main/storybook'],
    ]);
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
