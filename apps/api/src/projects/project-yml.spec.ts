import { ownerLanguageOf } from './project-yml';

describe('ownerLanguageOf', () => {
  it('reads owner.language from the block form the plugin writes', () => {
    expect(ownerLanguageOf('name: X\nowner:\n  language: en\n  timezone: Europe/Kyiv\n')).toBe('en');
    expect(ownerLanguageOf('owner:\n  timezone: UTC\n  language: ru\n')).toBe('ru');
  });

  it.each([
    ['a trailing comment', 'owner:\n  language: en   # owner-facing\n'],
    ['quotes', 'owner:\n  language: "en"\n'],
    ['single quotes and upper case', "owner:\n  language: 'EN'\n"],
    ['CRLF line ends', 'owner:\r\n  language: en\r\n'],
    ['comment lines and blank lines inside the block', 'owner:\n  # who reads\n\n  language: en\n'],
    ['the flow form', 'owner: { timezone: UTC, language: en }\n'],
  ])('handles %s', (_label, text) => {
    expect(ownerLanguageOf(text)).toBe('en');
  });

  it.each([
    ['an empty file', ''],
    ['no owner block', 'name: X\nlanguage: en\n'],
    ['language of another block', 'review:\n  language: en\nowner:\n  timezone: UTC\n'],
    ['a language the console does not have', 'owner:\n  language: de\n'],
    ['a commented-out language', 'owner:\n  # language: en\n'],
    ['a top-level key after the block', 'owner:\n  timezone: UTC\nlanguage: en\n'],
  ])('falls back to ru for %s', (_label, text) => {
    expect(ownerLanguageOf(text)).toBe('ru');
  });
});
