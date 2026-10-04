import { PROJECT_CONFIG_MAX_BYTES, ProjectConfigError, parseProjectConfig } from './project-config';

function failureOf(text: string): string {
  try {
    parseProjectConfig(text);
  } catch (error: unknown) {
    if (error instanceof ProjectConfigError) {
      return error.failure;
    }
    throw error;
  }
  return 'parsed';
}

describe('parseProjectConfig (#9 threat row 9)', () => {
  it('reads reviewer_logins as a flow list, a block list or absent', () => {
    expect(
      parseProjectConfig("team:\n  reviewer_logins: ['team-console-review[bot]']\n").reviewerLogins,
    ).toEqual(['team-console-review[bot]']);
    expect(
      parseProjectConfig('team:\n  reviewer_logins:\n    - a-reviewer # comment\n    - b\n').reviewerLogins,
    ).toEqual(['a-reviewer', 'b']);
    expect(parseProjectConfig('name: x\n').reviewerLogins).toEqual([]);
    expect(parseProjectConfig('team:\n  reviewer_logins: []\n').reviewerLogins).toEqual([]);
    expect(parseProjectConfig('team:\n  reviewer_logins:\n').reviewerLogins).toEqual([]);
  });

  it('refuses a file over 64 KB before parsing it (a 1 MB file)', () => {
    const big = `name: x\ndescription: "${'a'.repeat(1024 * 1024)}"\n`;
    expect(failureOf(big)).toBe('too-large');
    const justOver = `name: x\n#${'a'.repeat(PROJECT_CONFIG_MAX_BYTES)}\n`;
    expect(failureOf(justOver)).toBe('too-large');
  });

  it('counts bytes, not characters', () => {
    const cyrillic = `name: x\n#${'я'.repeat(PROJECT_CONFIG_MAX_BYTES / 2)}\n`;
    expect(cyrillic.length).toBeLessThan(PROJECT_CONFIG_MAX_BYTES);
    expect(failureOf(cyrillic)).toBe('too-large');
  });

  it('refuses an alias bomb (billion laughs) without expanding it', () => {
    const levels = ['a: &a ["lol","lol","lol","lol","lol","lol","lol","lol","lol"]'];
    for (let i = 1; i < 10; i += 1) {
      const prev = String.fromCharCode(96 + i);
      const next = String.fromCharCode(97 + i);
      levels.push(`${next}: &${next} [${Array(9).fill(`*${prev}`).join(',')}]`);
    }
    const bomb = `${levels.join('\n')}\nteam:\n  reviewer_logins: *j\n`;
    expect(new TextEncoder().encode(bomb).byteLength).toBeLessThan(PROJECT_CONFIG_MAX_BYTES);
    expect(failureOf(bomb)).toBe('aliases');
  });

  it('refuses any alias, a merge key included', () => {
    expect(failureOf("x: &x ['a']\nteam:\n  reviewer_logins: *x\n")).toBe('aliases');
    expect(failureOf('base: &b {reviewer_logins: [a]}\nteam:\n  <<: *b\n')).toBe('aliases');
  });

  it.each([
    ['a language tag', 'team: !!python/object:os.system {}\n'],
    ['a custom tag', 'team: !include other.yml\n'],
    ['a known YAML 1.1 tag', 'name: !!binary aGVsbG8=\n'],
    ['a duplicate key', 'team:\n  reviewer_logins: [a]\nteam:\n  reviewer_logins: []\n'],
    ['a second document', 'name: x\n---\nteam:\n  reviewer_logins: [a]\n'],
    ['broken YAML', 'team: [unclosed\n'],
  ])('refuses %s', (_label, text) => {
    expect(failureOf(text)).toBe('not-yaml');
  });

  it.each([
    ['an empty file', ''],
    ['a list at the top', '- a\n- b\n'],
    ['a scalar at the top', 'just text\n'],
    ['team as a list', 'team:\n  - reviewer_logins\n'],
    ['reviewer_logins as a string', 'team:\n  reviewer_logins: a, b\n'],
    ['an empty login', "team:\n  reviewer_logins: ['']\n"],
    ['a login with a space', "team:\n  reviewer_logins: ['a b']\n"],
    ['a number', 'team:\n  reviewer_logins: [42]\n'],
    ['a nested list', 'team:\n  reviewer_logins: [[a]]\n'],
  ])('refuses %s (schema)', (_label, text) => {
    expect(failureOf(text)).toBe('schema');
  });
});

describe('parseProjectConfig: the artifact fields (#19)', () => {
  it('reads decisions_dir, defaulting to docs/decisions and dropping a trailing slash', () => {
    expect(parseProjectConfig('name: x\n').decisionsDir).toBe('docs/decisions');
    expect(parseProjectConfig('decisions_dir: docs/adr/\n').decisionsDir).toBe('docs/adr');
  });

  it.each([
    ['a traversal', 'decisions_dir: docs/../../x\n'],
    ['an absolute path', 'decisions_dir: /etc\n'],
    ['a query', 'decisions_dir: "docs?ref=x"\n'],
    ['a number', 'decisions_dir: 7\n'],
  ])('reads %s in decisions_dir as unusable, without failing the config', (_label, text) => {
    expect(parseProjectConfig(text).decisionsDir).toBeNull();
  });

  it('keeps design.storybook_url only when it is a github.com page', () => {
    expect(
      parseProjectConfig("design:\n  storybook_url: 'https://github.com/o/r/tree/main/sb'\n").storybookUrl,
    ).toBe('https://github.com/o/r/tree/main/sb');
    expect(parseProjectConfig("design:\n  storybook_url: 'https://sb.example'\n").storybookUrl).toBeNull();
    expect(parseProjectConfig("design:\n  storybook_url: ''\n").storybookUrl).toBeNull();
  });
});
