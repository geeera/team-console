import type { InboxDto, InboxItemDto } from '@shared/contracts';
import { buildNeedsYou } from './needs-you';

function item(section: InboxItemDto['section'], number: number): InboxItemDto {
  return {
    section,
    number,
    key: null,
    askId: null,
    title: `#${number}`,
    url: null,
    ask: null,
    authorTrusted: true,
    category: null,
    recommendation: null,
    context: null,
  };
}

function inbox(items: InboxItemDto[], setup = false): InboxDto {
  return {
    items,
    setup,
    setupUrl: setup ? 'https://github.com/o/r/blob/HEAD/x' : null,
    paused: false,
    pausedUrl: null,
  };
}

describe('buildNeedsYou (#16: inbox order, then project, then number)', () => {
  const alpha = { slug: 'alpha', name: 'Alpha' };
  const beta = { slug: 'beta', name: 'Beta' };
  const gamma = { slug: 'gamma', name: 'Gamma' };

  const result = buildNeedsYou(
    [
      { project: alpha, inbox: inbox([item('owner', 3), item('question', 9), item('question', 2)], true) },
      { project: beta, inbox: inbox([item('release', 50), item('question', 1)]) },
      {
        project: gamma,
        problem: { type: 'github-app-not-installed', title: 'The console app is not installed', status: 409 },
      },
    ],
    [{ slug: 'delta', name: 'Delta' }],
  );

  it('sorts across projects by section, then registry order, then number', () => {
    expect(result.items.map((i) => `${i.section}:${i.project.slug}#${i.number}`)).toEqual([
      'release:beta#50',
      'question:alpha#2',
      'question:alpha#9',
      'question:beta#1',
      'owner:alpha#3',
    ]);
  });

  it('tags each item with its project and the answers its section allows', () => {
    expect(result.items[0]).toMatchObject({ project: beta, allowedCommands: ['go', 'no-go', 'override'] });
    expect(result.items[4]).toMatchObject({ project: alpha, allowedCommands: ['done'] });
  });

  it('reports per project: setup, and a problem instead of dropping the others', () => {
    expect(result.projects).toEqual([
      {
        ...alpha,
        setup: true,
        setupUrl: 'https://github.com/o/r/blob/HEAD/x',
        paused: false,
        pausedUrl: null,
        problem: null,
        canManage: true,
      },
      { ...beta, setup: false, setupUrl: null, paused: false, pausedUrl: null, problem: null, canManage: true },
      {
        ...gamma,
        setup: false,
        setupUrl: null,
        paused: false,
        pausedUrl: null,
        problem: { type: 'github-app-not-installed', title: 'The console app is not installed', status: 409 },
        canManage: true,
      },
    ]);
    expect(result.omittedProjects).toEqual([{ slug: 'delta', name: 'Delta' }]);
  });
});

describe('buildNeedsYou: canManage (#735)', () => {
  it('reads false only for the slugs the map names; everything else defaults to true', () => {
    const result = buildNeedsYou(
      [
        { project: { slug: 'alpha', name: 'Alpha' }, inbox: inbox([]) },
        { project: { slug: 'beta', name: 'Beta' }, inbox: inbox([]) },
      ],
      [],
      new Map(),
      new Map([['beta', false]]),
    );
    expect(result.projects.map((project) => [project.slug, project.canManage])).toEqual([
      ['alpha', true],
      ['beta', false],
    ]);
  });
});

describe('buildNeedsYou: the budget stop (#684)', () => {
  const stop = { month: '2026-11', spentUsd: 201.5, budgetUsd: 200, stoppedAt: '2026-11-16T10:00:00.000Z' };

  it('carries a project’s one stop, read or not, and nothing on the others', () => {
    const result = buildNeedsYou(
      [
        { project: { slug: 'alpha', name: 'Alpha' }, inbox: inbox([]) },
        { project: { slug: 'beta', name: 'Beta' }, inbox: inbox([]) },
        { project: { slug: 'gamma', name: 'Gamma' }, problem: { type: 'github-rate-limit', title: 'Rate limited', status: 429 } },
      ],
      [],
      new Map([
        ['alpha', stop],
        ['gamma', stop],
      ]),
    );
    expect(result.projects.map((project) => project.budgetStop)).toEqual([stop, undefined, stop]);
    expect(Object.hasOwn(result.projects[1] ?? {}, 'budgetStop')).toBe(false);
  });
});
