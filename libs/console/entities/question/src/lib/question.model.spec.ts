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
  ])('refuses %s', (_name, body) => {
    expect(isNeedsYouDto(body)).toBe(false);
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
