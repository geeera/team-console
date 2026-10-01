import { normalizeRepoInput } from './repo-input';

describe('normalizeRepoInput', () => {
  it.each([
    ['geeera/storify', 'geeera/storify', 'storify'],
    ['  geeera/storify \n', 'geeera/storify', 'storify'],
    ['https://github.com/geeera/storify', 'geeera/storify', 'storify'],
    ['https://github.com/geeera/storify.git', 'geeera/storify', 'storify'],
    ['https://github.com/geeera/storify/', 'geeera/storify', 'storify'],
    ['http://www.github.com/geeera/Team_Console.js', 'geeera/Team_Console.js', 'team-console-js'],
    ['github.com/acme/site?tab=readme', 'acme/site', 'site'],
    ['Geeera/My.Repo', 'Geeera/My.Repo', 'my-repo'],
  ])('%j → %s (/p/%s)', (raw, repo, slug) => {
    expect(normalizeRepoInput(raw)).toEqual({ ok: true, repo, slug });
  });

  it.each(['', '   '])('%j is empty', (raw) => {
    expect(normalizeRepoInput(raw)).toEqual({ ok: false, reason: 'empty' });
  });

  it.each([
    'storify',
    'geeera storify',
    'geeera/',
    '/storify',
    'geeera/storify/issues',
    '-geeera/storify',
    'gee era/storify',
    'geeera/sto ry',
    'geeera/..',
    'https://gitlab.com/geeera/storify',
    'https://github.com/geeera',
    `${'a'.repeat(40)}/storify`,
    `geeera/${'a'.repeat(101)}`,
    // Names whose slug the Worker refuses: too short, or a console route.
    'geeera/x',
    'geeera/settings',
  ])('%j is not owner/repo', (raw) => {
    expect(normalizeRepoInput(raw)).toEqual({ ok: false, reason: 'format' });
  });
});
