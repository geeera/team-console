import { pushTargetOf, questionNumberOf } from './push-target';

describe('pushTargetOf', () => {
  it('accepts the two targets the Worker builds', () => {
    expect(pushTargetOf('/needs-you')).toEqual({ kind: 'needs-you' });
    expect(pushTargetOf('/p/storify/questions#42')).toEqual({ kind: 'question', slug: 'storify', number: 42 });
    expect(pushTargetOf('/p/team-console/questions#7')).toEqual({
      kind: 'question',
      slug: 'team-console',
      number: 7,
    });
  });

  it.each([
    ['another origin', 'https://evil.example/needs-you'],
    ['a protocol-relative URL', '//evil.example/p/storify/questions#1'],
    ['a backslash trick', '/\\evil.example/needs-you'],
    ['a scheme', 'javascript:alert(1)'],
    ['a relative path', 'p/storify/questions#1'],
    ['a query', '/needs-you?x=1'],
    ['a fragment on Needs you', '/needs-you#1'],
    ['no fragment', '/p/storify/questions'],
    ['a fragment that is not digits', '/p/storify/questions#42abc'],
    ['an element id as fragment', '/p/storify/questions#tc-main'],
    ['a negative number', '/p/storify/questions#-1'],
    ['zero', '/p/storify/questions#0'],
    ['an empty fragment', '/p/storify/questions#'],
    ['an invalid slug', '/p/Storify/questions#1'],
    ['an encoded slug', '/p/st%6Frify/questions#1'],
    ['dot segments', '/p/storify/../settings/questions#1'],
    ['another section', '/p/storify/board#1'],
    ['a deeper path', '/p/storify/questions/1#1'],
    ['not a string', 42],
    ['nothing', undefined],
  ])('ignores %s', (_, url) => {
    expect(pushTargetOf(url)).toBeNull();
  });
});

describe('questionNumberOf', () => {
  it('takes digits only', () => {
    expect(questionNumberOf('72')).toBe(72);
    expect(questionNumberOf(' 72')).toBeNull();
    expect(questionNumberOf('7e2')).toBeNull();
    expect(questionNumberOf('0x10')).toBeNull();
    expect(questionNumberOf('')).toBeNull();
    expect(questionNumberOf(null)).toBeNull();
    expect(questionNumberOf('9999999999999999')).toBeNull();
  });
});
