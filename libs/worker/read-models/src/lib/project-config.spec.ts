import {
  PROJECT_CONFIG_MAX_BYTES,
  ProjectConfigError,
  embedOriginOf,
  embedOriginsOf,
  parseProjectConfig,
} from './project-config';

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

describe('embedOriginOf (#20)', () => {
  it.each([
    ['https://storify.pages.dev/?path=/story/button', 'https://storify.pages.dev'],
    ['  https://stage.storify.workers.dev/app/  ', 'https://stage.storify.workers.dev'],
    ['https://geeera.github.io/team-console/wireframes/', 'https://geeera.github.io'],
    ['https://example.com:8443/x', 'https://example.com:8443'],
    ['HTTPS://Storify.Pages.Dev', 'https://storify.pages.dev'],
  ])('reduces %s to the exact origin %s', (url, origin) => {
    expect(embedOriginOf(url)).toBe(origin);
  });

  it.each([
    ['plain http', 'http://storify.pages.dev'],
    ['javascript:', 'javascript:alert(1)'],
    ['data:', 'data:text/html,<script>alert(1)</script>'],
    ['a relative path', '/storybook'],
    ['a scheme-relative URL', '//storify.pages.dev'],
    ['credentials', 'https://user:pass@storify.pages.dev'],
    ['a user name only', 'https://user@storify.pages.dev'],
    ['a wildcard host', 'https://*.pages.dev'],
    ['a host with an underscore', 'https://my_site.pages.dev'],
    ['a trailing-dot host', 'https://storify.pages.dev./'],
    ['an IPv6 literal', 'https://[::1]/'],
    ['an empty string', ''],
    ['whitespace', '   '],
    ['a URL over 2048 characters', `https://storify.pages.dev/${'a'.repeat(2048)}`],
    ['a number', 443],
    ['null', null],
    ['a list', ['https://storify.pages.dev']],
  ])('refuses %s', (_label, value) => {
    expect(embedOriginOf(value)).toBeNull();
  });
});

describe('embedOriginsOf (#20)', () => {
  const CONSOLE = 'https://team-console-dev.geeera.workers.dev';

  it('reads design.storybook_url only; stage and the other environments stay link-only', () => {
    const text = [
      'design:',
      '  storybook_url: https://storify.pages.dev/',
      '  figma_url: https://figma.example/file',
      'environments:',
      '  dev: { url: "https://dev.storify.workers.dev" }',
      '  stage:',
      '    url: "https://stage.storify.workers.dev/"',
      '  production: { url: "https://storify.example" }',
      '',
    ].join('\n');
    expect(embedOriginsOf(text, CONSOLE)).toEqual(['https://storify.pages.dev']);
  });

  it('skips empty, missing and non-https values, keeping the valid one', () => {
    expect(
      embedOriginsOf(
        'design:\n  storybook_url: ""\nenvironments:\n  stage:\n    url: https://s.workers.dev\n',
        CONSOLE,
      ),
    ).toEqual([]);
    expect(embedOriginsOf('design:\n  storybook_url: http://s.pages.dev\n', CONSOLE)).toEqual([]);
    expect(embedOriginsOf('name: x\n', CONSOLE)).toEqual([]);
    expect(embedOriginsOf('design: https://s.pages.dev\nenvironments: [stage]\n', CONSOLE)).toEqual([]);
  });

  it('embeds nothing from a file the safe parser refuses, instead of throwing', () => {
    expect(embedOriginsOf('design: &a { storybook_url: https://s.pages.dev }\nx: *a\n', CONSOLE)).toEqual([]);
    expect(embedOriginsOf('design: { storybook_url: !!js/function "f" }\n', CONSOLE)).toEqual([]);
    expect(
      embedOriginsOf(
        `design:\n  storybook_url: https://s.pages.dev\n#${'a'.repeat(PROJECT_CONFIG_MAX_BYTES)}\n`,
        CONSOLE,
      ),
    ).toEqual([]);
  });

  it('does not depend on reviewer_logins being valid', () => {
    const text = 'team:\n  reviewer_logins: 42\ndesign:\n  storybook_url: https://s.pages.dev\n';
    expect(failureOf(text)).toBe('schema');
    expect(embedOriginsOf(text, CONSOLE)).toEqual(['https://s.pages.dev']);
  });

  it("drops the console's own origin, even when project.yml names it as the Storybook", () => {
    const text = 'design: { storybook_url: "https://team-console-dev.geeera.workers.dev/storybook/" }\n';
    expect(embedOriginsOf(text, 'https://team-console-dev.geeera.workers.dev')).toEqual([]);
    expect(embedOriginsOf(text, 'https://team-console-stage.geeera.workers.dev')).toEqual([
      'https://team-console-dev.geeera.workers.dev',
    ]);
  });
});
