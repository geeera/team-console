import type { ItemSummaryDto } from '@shared/contracts';
import { findQueryOf, githubIssueUrl, matchesOf, type FindProject } from './find-query';

const HERE: FindProject = {
  slug: 'team-console',
  name: 'team-console',
  repo: 'geeera/team-console',
  keyPrefix: 'TC',
  isOnConsole: true,
};
const STORIFY: FindProject = {
  slug: 'storify',
  name: 'storify',
  repo: 'geeera/storify',
  keyPrefix: null,
  isOnConsole: false,
};
const GHOST: FindProject = {
  slug: 'ghost',
  name: 'ghost',
  repo: 'geeera/ghost',
  keyPrefix: 'GH',
  isOnConsole: true,
};

describe('findQueryOf', () => {
  const of = (text: string) => findQueryOf(text, HERE, [STORIFY, GHOST]);

  it('reads 142, #142 and TC-142 as this project’s number', () => {
    expect(of('142')).toEqual({ kind: 'number', number: 142 });
    expect(of(' #142 ')).toEqual({ kind: 'number', number: 142 });
    expect(of('tc-142')).toEqual({ kind: 'number', number: 142 });
  });

  it('resolves a pasted GitHub issue link: here by its number, another project there', () => {
    expect(of('https://github.com/geeera/team-console/issues/142')).toEqual({ kind: 'number', number: 142 });
    expect(of('https://github.com/geeera/storify/issues/7')).toEqual({
      kind: 'elsewhere',
      project: STORIFY,
      number: 7,
    });
    expect(of('GH-3')).toEqual({ kind: 'elsewhere', project: GHOST, number: 3 });
    expect(of('https://github.com/someone/else/issues/1')).toEqual({ kind: 'unknown-link' });
  });

  it('never takes a look-alike host or a pull request link as an issue', () => {
    expect(of('https://github.com.evil.example/geeera/team-console/issues/1').kind).toBe('words');
    expect(of('https://github.com/geeera/team-console/pull/415').kind).toBe('words');
    expect(of('http://github.com/geeera/team-console/issues/1').kind).toBe('words');
  });

  it('splits anything else into words, and nothing into empty', () => {
    expect(of('  Slow   Network ')).toEqual({ kind: 'words', words: ['slow', 'network'] });
    expect(of('   ')).toEqual({ kind: 'empty' });
  });
});

describe('matchesOf', () => {
  const item = (number: number, title: string, state: 'open' | 'closed') =>
    ({ number, title, state }) as ItemSummaryDto;

  it('needs every word, lists open before closed and newest first', () => {
    const items = [
      item(1, 'Answer on a slow network', 'closed'),
      item(2, 'Slow network retry', 'open'),
      item(3, 'Network', 'open'),
    ];
    expect(matchesOf(items, ['slow', 'network']).map((found) => found.number)).toEqual([2, 1]);
  });

  it('links GitHub issues of a well-formed repository only', () => {
    expect(githubIssueUrl(STORIFY, 7)).toBe('https://github.com/geeera/storify/issues/7');
    expect(githubIssueUrl({ ...STORIFY, repo: 'evil.example/../x' }, 7)).toBeNull();
  });
});
