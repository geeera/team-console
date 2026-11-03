import { freezeDaysOf, ownerLanguageOf } from './project-yml';

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

describe('freezeDaysOf (#218)', () => {
  it('reads sprint.freeze_days from the block form the plugin writes', () => {
    expect(freezeDaysOf('name: X\nsprint:\n  length_days: 14\n  freeze_days: 3\n')).toBe(3);
    expect(freezeDaysOf('sprint:\n  freeze_days: 0   # no freeze\n')).toBe(0);
  });

  it.each([
    ['the flow form', 'sprint: { length_days: 14, freeze_days: 4 }\n', 4],
    ['quotes', 'sprint:\n  freeze_days: "5"\n', 5],
    ['CRLF line ends', 'sprint:\r\n  freeze_days: 1\r\n', 1],
  ])('handles %s', (_label, text, days) => {
    expect(freezeDaysOf(text)).toBe(days);
  });

  it.each([
    ['an empty file', ''],
    ['no sprint block', 'name: X\nfreeze_days: 5\n'],
    ['freeze_days of another block', 'review:\n  freeze_days: 5\nsprint:\n  length_days: 14\n'],
    ['a negative number', 'sprint:\n  freeze_days: -1\n'],
    ['a fraction', 'sprint:\n  freeze_days: 1.5\n'],
    ['a word', 'sprint:\n  freeze_days: two\n'],
    ['more than two weeks', 'sprint:\n  freeze_days: 30\n'],
    ['a commented-out value', 'sprint:\n  # freeze_days: 5\n'],
  ])('falls back to 2 for %s', (_label, text) => {
    expect(freezeDaysOf(text)).toBe(2);
  });
});
