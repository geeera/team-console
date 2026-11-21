import { SetupTokenFilter, cleanTerminalText, type StreamName } from './token-filter';

const TOKEN = `sk-ant-oat01-${'Ab3_-'.repeat(20)}xyz`;
const OTHER = `sk-ant-oat01-${'Zq9_-'.repeat(20)}xyz`;
const API_KEY = `sk-ant-api03-${'Ab3_-'.repeat(20)}`;
const URL_LINE = 'Browser didn’t open? Use the url below to sign in:\nhttps://claude.ai/oauth/authorize?code=true\n';

function run(chunks: readonly (readonly [StreamName, string | Buffer])[]): {
  forwarded: string;
  outcome: ReturnType<SetupTokenFilter['end']>;
} {
  let forwarded = '';
  const filter = new SetupTokenFilter({
    stdout: (text) => (forwarded += text),
    stderr: (text) => (forwarded += text),
  });
  for (const [name, chunk] of chunks) {
    filter.write(name, chunk);
  }
  return { forwarded, outcome: filter.end() };
}

/** Nothing of the token may reach the terminal: not whole, and not a fragment of 8 or more of its characters. */
function expectNoFragment(forwarded: string, token: string): void {
  for (let start = 0; start + 8 <= token.length; start += 1) {
    expect(forwarded).not.toContain(token.slice(start, start + 8));
  }
}

describe('SetupTokenFilter', () => {
  it('forwards the sign-in prompts, captures one token and forwards nothing from it on', () => {
    const { forwarded, outcome } = run([
      ['stdout', URL_LINE],
      ['stdout', 'Paste code here if prompted > '],
      ['stdout', `\n✓ Long-lived authentication token created successfully!\n\nYour OAuth token:\n\n${TOKEN}\n\nStore this token securely.\n`],
    ]);
    expect(outcome).toEqual({ kind: 'token', value: TOKEN });
    expect(forwarded).toContain('https://claude.ai/oauth/authorize?code=true');
    expect(forwarded).toContain('Paste code here if prompted > ');
    expect(forwarded).not.toContain('Store this token');
    expectNoFragment(forwarded, TOKEN);
  });

  it('refuses a token wrapped across two lines and forwards neither half', () => {
    const { forwarded, outcome } = run([['stdout', `Your OAuth token:\n${TOKEN.slice(0, 60)}\n${TOKEN.slice(60)}\nDone and dusted.\n`]]);
    expect(outcome).toEqual({ kind: 'refused', reason: 'wrapped' });
    expectNoFragment(forwarded, TOKEN);
  });

  it('matches through ANSI colour and an OSC title, and forwards no part of the token', () => {
    const coloured = `\x1b[1m\x1b[32ms\x1b[0mk\x1b]0;title\x07-${TOKEN.slice(3)}\x1b[0m\n`;
    const { forwarded, outcome } = run([['stdout', `token: ${coloured}`]]);
    expect(outcome).toEqual({ kind: 'token', value: TOKEN });
    expectNoFragment(forwarded, TOKEN);
    expect(forwarded).toBe('token: ');
  });

  it('treats \\r redraws as line breaks and still captures', () => {
    const { forwarded, outcome } = run([['stdout', `Working…\rWorking… done\r\n${TOKEN}\r\n`]]);
    expect(outcome).toEqual({ kind: 'token', value: TOKEN });
    expect(forwarded).toBe('Working…\nWorking… done\n');
  });

  it('holds a trailing "s" or "sk" across a chunk boundary instead of flushing it', () => {
    const forwardedChunks: string[] = [];
    const filter = new SetupTokenFilter({ stdout: (text) => forwardedChunks.push(text), stderr: () => undefined });
    filter.write('stdout', 'Paste code > s');
    expect(forwardedChunks.join('')).toBe('Paste code > ');
    filter.write('stdout', 'k');
    filter.write('stdout', `-${TOKEN.slice(3, 20)}`);
    filter.write('stdout', `${TOKEN.slice(20)}\n`);
    expect(filter.end()).toEqual({ kind: 'token', value: TOKEN });
    expect(forwardedChunks.join('')).toBe('Paste code > ');
  });

  it('flushes a held "s" that turns out to be ordinary text', () => {
    const { forwarded } = run([['stdout', 'yes'], ['stdout', ' please\n']]);
    expect(forwarded).toBe('yes please\n');
  });

  it('splits a token over byte chunks inside a multi-byte character and an escape', () => {
    const bytes = Buffer.from(`✓ ok\n\x1b[2m${TOKEN}\x1b[0m\n`, 'utf8');
    const chunks = Array.from({ length: bytes.length }, (_, index) => ['stdout', bytes.subarray(index, index + 1)] as const);
    const { forwarded, outcome } = run(chunks);
    expect(outcome).toEqual({ kind: 'token', value: TOKEN });
    expect(forwarded).toBe('✓ ok\n');
  });

  it('filters stderr the same way, and stops stdout too once stderr shows a key', () => {
    const { forwarded, outcome } = run([
      ['stdout', 'before\n'],
      ['stderr', `debug: ${TOKEN}\n`],
      ['stdout', 'after\n'],
    ]);
    expect(outcome).toEqual({ kind: 'token', value: TOKEN });
    expect(forwarded).toBe('before\ndebug: ');
  });

  it('refuses two different tokens', () => {
    const { forwarded, outcome } = run([['stdout', `${TOKEN}\n${OTHER}\n`]]);
    expect(outcome).toEqual({ kind: 'refused', reason: 'two-tokens' });
    expectNoFragment(forwarded, TOKEN);
    expectNoFragment(forwarded, OTHER);
  });

  it('accepts the same token printed twice', () => {
    expect(run([['stdout', `${TOKEN}\nexport CLAUDE_CODE_OAUTH_TOKEN=${TOKEN}\n`]]).outcome).toEqual({
      kind: 'token',
      value: TOKEN,
    });
  });

  it('refuses an API key and forwards none of it', () => {
    const { forwarded, outcome } = run([['stdout', `${API_KEY}\n`]]);
    expect(outcome).toEqual({ kind: 'refused', reason: 'api-key' });
    expectNoFragment(forwarded, API_KEY);
  });

  it('refuses a token next to an API key', () => {
    expect(run([['stdout', `${TOKEN}\n${API_KEY}\n`]]).outcome).toEqual({ kind: 'refused', reason: 'api-key' });
  });

  it('refuses a key start that is no well-formed token', () => {
    expect(run([['stdout', 'sk-ant-oat01-short\n']]).outcome).toEqual({ kind: 'refused', reason: 'malformed' });
    expect(run([['stdout', `"${TOKEN}"\n`]]).outcome).toEqual({ kind: 'refused', reason: 'malformed' });
  });

  it('refuses when no token was printed', () => {
    const { forwarded, outcome } = run([['stdout', 'Login cancelled.\n']]);
    expect(outcome).toEqual({ kind: 'refused', reason: 'no-token' });
    expect(forwarded).toBe('Login cancelled.\n');
  });

  it('refuses when the output after the key start is beyond any CLI', () => {
    expect(run([['stdout', `${TOKEN}\n${'x'.repeat(70 * 1024)}`]]).outcome).toEqual({ kind: 'refused', reason: 'overflow' });
  });

  it('does not let a zero-width or backspace character hide the key start', () => {
    const { forwarded, outcome } = run([['stdout', `s\u200bk\b-${TOKEN.slice(3)}\n`]]);
    expect(outcome).toEqual({ kind: 'token', value: TOKEN });
    expectNoFragment(forwarded, TOKEN);
  });
});

describe('cleanTerminalText', () => {
  it('keeps an unfinished escape and a trailing \\r for the next chunk', () => {
    expect(cleanTerminalText('ab\x1b[3', false)).toEqual({ clean: 'ab', rest: '\x1b[3' });
    expect(cleanTerminalText('ab\r', false)).toEqual({ clean: 'ab', rest: '\r' });
    expect(cleanTerminalText('ab\r', true)).toEqual({ clean: 'ab\n', rest: '' });
  });

  it('drops an escape the filter does not know, keeping the text after it', () => {
    expect(cleanTerminalText('a\x1b\x01b', true)).toEqual({ clean: 'ab', rest: '' });
  });
});
