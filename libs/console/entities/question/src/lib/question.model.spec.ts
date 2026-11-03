import type { NeedsYouDto, QuestionsDto } from '@shared/contracts';
import {
  githubIssueUrlOf,
  isNeedsYouDto,
  isQuestionsDto,
  needsYouViewOf,
  projectQuestionsOf,
  safeGitHubUrl,
} from './question.model';

const needsYou = (): NeedsYouDto => ({
  items: [
    {
      section: 'question',
      number: 72,
      title: 'План к демо',
      url: 'https://github.com/geeera/team-console/issues/72',
      ask: '/approve — начинаем',
      authorTrusted: true,
      category: 'scope',
      recommendation: null,
      context: {
        summary: 'Кратко',
        question: 'Начинаем?',
        why: null,
        ifApproved: 'Начнём.',
        ifRejected: null,
        costAndRisk: null,
        structured: true,
      },
      project: { slug: 'team-console', name: 'Team Console' },
      allowedCommands: ['approve', 'reject'],
    },
    {
      section: 'release',
      number: 9,
      title: 'Demo go / no-go',
      url: null,
      ask: null,
      authorTrusted: false,
      category: null,
      recommendation: null,
      context: null,
      project: { slug: 'storify', name: 'Storify' },
      allowedCommands: ['go', 'no-go', 'override'],
    },
  ],
  projects: [
    {
      slug: 'team-console',
      name: 'Team Console',
      setup: false,
      setupUrl: null,
      paused: false,
      pausedUrl: null,
      problem: null,
    },
    {
      slug: 'storify',
      name: 'Storify',
      setup: false,
      setupUrl: null,
      paused: false,
      pausedUrl: null,
      problem: null,
    },
    {
      slug: 'broken',
      name: 'Broken',
      setup: false,
      setupUrl: null,
      paused: false,
      pausedUrl: null,
      problem: { type: 'github-app-not-installed', title: 'not installed', status: 409 },
    },
  ],
  omittedProjects: [{ slug: 'seventh', name: 'Seventh' }],
});

describe('isNeedsYouDto', () => {
  it('accepts the #35 body', () => {
    expect(isNeedsYouDto(needsYou())).toBe(true);
  });

  it.each([
    ['a non-object', 'x'],
    ['items missing', { projects: [], omittedProjects: [] }],
    ['an unknown section', { ...needsYou(), items: [{ ...needsYou().items[0], section: 'chat' }] }],
    [
      'an unknown command',
      { ...needsYou(), items: [{ ...needsYou().items[0], allowedCommands: ['merge'] }] },
    ],
    ['a string number', { ...needsYou(), items: [{ ...needsYou().items[0], number: '72' }] }],
    ['no project tag', { ...needsYou(), items: [{ ...needsYou().items[0], project: null }] }],
    ['trust missing', { ...needsYou(), items: [{ ...needsYou().items[0], authorTrusted: 'yes' }] }],
    ['an unknown category', { ...needsYou(), items: [{ ...needsYou().items[0], category: 'fun' }] }],
    ['no category member', { ...needsYou(), items: [{ ...needsYou().items[0], category: undefined }] }],
    [
      'an unknown recommendation',
      { ...needsYou(), items: [{ ...needsYou().items[0], recommendation: 'override' }] },
    ],
    [
      'a context field that is not text',
      { ...needsYou(), items: [{ ...needsYou().items[0], context: { ...needsYou().items[0]?.context, why: 1 } }] },
    ],
    [
      'a context without structured',
      { ...needsYou(), items: [{ ...needsYou().items[0], context: { summary: 'x' } }] },
    ],
  ])('refuses %s', (_name, body) => {
    expect(isNeedsYouDto(body)).toBe(false);
  });
});

describe('question context (#276)', () => {
  it('carries the server context, and reads a missing one as none', () => {
    const view = needsYouViewOf(needsYou());
    expect(view.items[0]?.context).toMatchObject({ summary: 'Кратко', structured: true });
    expect(view.items[1]?.context).toBeNull();

    const older = { ...needsYou(), items: needsYou().items.map(({ context: _context, ...rest }) => rest) };
    expect(isNeedsYouDto(older)).toBe(true);
    expect(needsYouViewOf(older as unknown as NeedsYouDto).items[0]?.context).toBeNull();
  });
});

describe('needsYouViewOf', () => {
  it('keeps the server order and tags, lists read projects, problems and omitted ones', () => {
    const view = needsYouViewOf(needsYou());

    expect(view.items.map((item) => `${item.project.slug}#${item.number}`)).toEqual([
      'team-console#72',
      'storify#9',
    ]);
    expect(view.items[0]?.body).toBeNull();
    expect(view.readSlugs).toEqual(['team-console', 'storify']);
    expect(view.problems).toEqual([
      {
        project: { slug: 'broken', name: 'Broken' },
        problem: { type: 'github-app-not-installed', title: 'not installed', status: 409 },
      },
    ]);
    expect(view.omitted).toEqual([{ slug: 'seventh', name: 'Seventh' }]);
    expect(view.setups).toEqual([]);
  });

  it('lists projects that need setup with their github.com checklist link (#205)', () => {
    const body = needsYou();
    const checklist = 'https://github.com/geeera/storify/blob/HEAD/.product-team/owner-checklist.md';
    const view = needsYouViewOf({
      ...body,
      projects: [
        { ...body.projects[0]!, setup: true, setupUrl: 'https://evil.example/owner-checklist.md' },
        { ...body.projects[1]!, setup: true, setupUrl: checklist },
        body.projects[2]!,
      ],
    });

    expect(view.setups).toEqual([
      { project: { slug: 'team-console', name: 'Team Console' }, url: null },
      { project: { slug: 'storify', name: 'Storify' }, url: checklist },
    ]);
  });

  it('a project whose inbox could not be read is a problem, never also a setup row', () => {
    const body = needsYou();
    const view = needsYouViewOf({
      ...body,
      projects: [{ ...body.projects[2]!, setup: true, setupUrl: 'https://github.com/geeera/broken' }],
    });

    expect(view.setups).toEqual([]);
    expect(view.problems).toHaveLength(1);
  });

  it('offers only the commands the owner grammar allows for the section', () => {
    const body = needsYou();
    const view = needsYouViewOf({
      ...body,
      items: body.items
        .slice(0, 1)
        .map((item) => ({ ...item, allowedCommands: ['approve', 'go', 'done', 'reject'] })),
    });

    expect(view.items[0]?.allowedCommands).toEqual(['approve', 'reject']);
  });
});

describe('projectQuestionsOf / isQuestionsDto', () => {
  it('carries the body and tags every item with the project', () => {
    const dto: QuestionsDto = {
      items: [
        {
          section: 'owner',
          number: 21,
          title: 'Cloudflare account',
          url: 'https://github.com/geeera/team-console/issues/21',
          ask: null,
          authorTrusted: true,
          category: null,
          recommendation: null,
          context: null,
          body: 'Steps\n1. …',
          allowedCommands: ['done'],
        },
      ],
    };

    expect(isQuestionsDto(dto)).toBe(true);
    expect(isQuestionsDto({ items: [{ ...dto.items[0], body: null }] })).toBe(false);
    const [item] = projectQuestionsOf({ slug: 'team-console', name: 'Team Console' }, dto);
    expect(item?.project).toEqual({ slug: 'team-console', name: 'Team Console' });
    expect(item?.body).toBe('Steps\n1. …');
    expect(item?.allowedCommands).toEqual(['done']);
  });
});

describe('safeGitHubUrl', () => {
  it('keeps github.com links only', () => {
    expect(safeGitHubUrl('https://github.com/a/b/issues/1')).toBe('https://github.com/a/b/issues/1');
    expect(safeGitHubUrl('javascript:alert(1)')).toBeNull();
    expect(safeGitHubUrl('https://github.com.evil.example/a')).toBeNull();
    expect(safeGitHubUrl('http://github.com/a')).toBeNull();
    expect(safeGitHubUrl(null)).toBeNull();
  });
});

describe('githubIssueUrlOf', () => {
  it('links the registry repository’s issue', () => {
    expect(githubIssueUrlOf('geeera/storify', 42)).toBe('https://github.com/geeera/storify/issues/42');
  });

  it('refuses a repository or number it cannot trust', () => {
    expect(githubIssueUrlOf('geeera/storify/../x', 42)).toBeNull();
    expect(githubIssueUrlOf('//evil.example/x', 42)).toBeNull();
    expect(githubIssueUrlOf('geeera', 42)).toBeNull();
    expect(githubIssueUrlOf('geeera/storify', 0)).toBeNull();
    expect(githubIssueUrlOf('geeera/storify', 1.5)).toBeNull();
  });
});
