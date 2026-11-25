import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { guarded, markersOf, tokenFor } from './guard-output.mjs';

const SCRIPT = join(import.meta.dirname, 'guard-output.mjs');
const TOKEN_A = 'a'.repeat(32);
const TOKEN_B = 'b'.repeat(32);

/** Hands out the given tokens in turn, then fails the test. */
function tokens(...values: string[]): () => string {
  const left = [...values];
  return () => {
    const next = left.shift();
    if (next === undefined) throw new Error('asked for more tokens than the test has');
    return next;
  };
}

function run(input: string, args: string[] = [], script = SCRIPT) {
  return spawnSync(process.execPath, [script, ...args], { input, encoding: 'utf8' });
}

/** What the runner does with a guarded block: the first line stops commands, the last resumes them. */
function split(output: string): { token: string; body: string } {
  const lines = output.split('\n');
  const open = /^::stop-commands::([0-9a-f]{32})$/.exec(lines[0] ?? '');
  expect(open, lines[0]).not.toBeNull();
  const token = open?.[1] ?? '';
  expect(lines.at(-1)).toBe('');
  expect(lines.at(-2)).toBe(`::${token}::`);
  return { token, body: lines.slice(1, -2).join('\n') };
}

describe('workflow-command guard', () => {
  describe('guarded', () => {
    it('puts the text between the stop marker and the marker that resumes', () => {
      expect(guarded('one\ntwo\n', tokens(TOKEN_A))).toBe(
        `::stop-commands::${TOKEN_A}\none\ntwo\n::${TOKEN_A}::\n`,
      );
    });

    it('ends the last line, so the closing marker starts a line of its own', () => {
      expect(guarded('no newline', tokens(TOKEN_A))).toBe(
        `::stop-commands::${TOKEN_A}\nno newline\n::${TOKEN_A}::\n`,
      );
      expect(guarded('', tokens(TOKEN_A))).toBe(`::stop-commands::${TOKEN_A}\n\n::${TOKEN_A}::\n`);
    });

    // #1013: both forms the runner reads, `::name::` at the start of a line and `##[name]` anywhere in one.
    it.each([
      '::error::from the image',
      '::add-mask::value',
      '::stop-commands::other',
      '##[error]from the image',
      '#12 1.234 a build line ##[add-mask]value',
      '##[set-output name=leak;]value',
    ])('keeps %s inside the markers, as written', (line) => {
      const output = guarded(`before\n${line}\nafter`, tokens(TOKEN_A));
      const lines = output.split('\n');
      expect(lines.indexOf(line)).toBeGreaterThan(lines.indexOf(`::stop-commands::${TOKEN_A}`));
      expect(lines.indexOf(line)).toBeLessThan(lines.indexOf(`::${TOKEN_A}::`));
      // One opening and one closing marker: the text adds neither.
      expect(lines.filter((candidate) => candidate === `::${TOKEN_A}::`)).toHaveLength(1);
    });
  });

  describe('tokenFor', () => {
    it('takes another token when the text holds the first, in either marker form or bare', () => {
      for (const text of [`::${TOKEN_A}::`, `##[${TOKEN_A}]`, `x${TOKEN_A}x`]) {
        expect(tokenFor(text, tokens(TOKEN_A, TOKEN_B))).toBe(TOKEN_B);
      }
    });

    it('refuses to print when no token is free of the text', () => {
      expect(() => tokenFor(TOKEN_A, () => TOKEN_A)).toThrow('no token that the text does not contain');
    });

    it.each(['', 'short', `${TOKEN_A}\n`, 'G'.repeat(32), 'error'])(
      'refuses %j from the token source: a marker must be 32 hex digits',
      (token) => {
        expect(() => tokenFor('text', () => token)).toThrow('not a token');
      },
    );

    it('makes a new random token on every call', () => {
      const made = new Set(Array.from({ length: 50 }, () => tokenFor('text')));
      expect(made.size).toBe(50);
      for (const token of made) expect(token).toMatch(/^[0-9a-f]{32}$/);
    });
  });

  it('markersOf gives the two lines the runner pairs', () => {
    expect(markersOf(TOKEN_A)).toEqual({
      open: `::stop-commands::${TOKEN_A}\n`,
      close: `::${TOKEN_A}::\n`,
    });
  });

  // CI prints these lines bare and through the guard, and reads which of them the runner acted on.
  it('has a probe with one line of each form the runner reads, the bracket form behind a prefix', () => {
    const probe = readFileSync(join(import.meta.dirname, 'guard-probe.txt'), 'utf8');
    expect(probe.split('\n')).toEqual([
      '::set-output name=PROBE_colon::on',
      'a prefix ##[set-output name=PROBE_bracket]on',
      '',
    ]);
  });

  describe('as the job runs it', () => {
    const TEXT = 'healthz: ok\n::error::x\nline ##[error]y\n';

    it('prints stdin between the markers and exits 0', () => {
      const result = run(TEXT);
      expect(result.status).toBe(0);
      expect(result.stderr).toBe('');
      expect(split(result.stdout).body).toBe(TEXT.trimEnd());
    });

    it('ends an unfinished last line before the closing marker', () => {
      expect(split(run('no newline').stdout).body).toBe('no newline');
      expect(split(run('').stdout).body).toBe('');
    });

    // The container's log is read to its end before the token exists, so no line of it can name the token.
    it('never repeats a token, and never prints one the text holds', () => {
      const first = split(run(TEXT).stdout).token;
      const second = split(run(`${TEXT}::${first}::\n`).stdout).token;
      expect(second).not.toBe(first);
    });

    it('keeps bytes that are not UTF-8 from breaking the markers', () => {
      const result = spawnSync(process.execPath, [SCRIPT], { input: Buffer.from([0xff, 0xfe, 0x0a, 0x41]) });
      expect(result.status).toBe(0);
      const output = result.stdout.toString('utf8');
      expect(output).toMatch(/^::stop-commands::[0-9a-f]{32}\n/);
      expect(output).toMatch(/A\n::[0-9a-f]{32}::\n$/);
    });

    describe('--stream', () => {
      it('prints stdin between the markers as it comes and exits 0', () => {
        const result = run(TEXT, ['--stream']);
        expect(result.status).toBe(0);
        expect(result.stderr).toBe('');
        expect(split(result.stdout).body).toBe(TEXT.trimEnd());
      });

      it('ends an unfinished last line, and prints both markers for no input at all', () => {
        expect(split(run('no newline', ['--stream']).stdout).body).toBe('no newline');
        const empty = run('', ['--stream']);
        expect(empty.stdout).toMatch(/^::stop-commands::([0-9a-f]{32})\n::\1::\n$/);
      });

      it('passes the bytes through unchanged', () => {
        const bytes = Buffer.from([0x61, 0xff, 0x00, 0x0d, 0x0a]);
        const result = spawnSync(process.execPath, [SCRIPT, '--stream'], { input: bytes });
        const body = result.stdout.subarray(result.stdout.indexOf(0x0a) + 1);
        expect(body.subarray(0, bytes.length).equals(bytes)).toBe(true);
      });
    });

    it.each([[['--buffer']], [['--stream', 'extra']], [['file.txt']]])('exits 2 on %j', (args) => {
      const result = run(TEXT, args);
      expect(result.status).toBe(2);
      expect(result.stdout).toBe('');
      expect(result.stderr).toContain('usage: ');
    });

    it('still guards when it is started through a symlink', () => {
      const directory = mkdtempSync(join(tmpdir(), 'guard-output-'));
      try {
        const linked = join(directory, 'linked.mjs');
        symlinkSync(SCRIPT, linked);
        expect(split(run(TEXT, [], linked).stdout).body).toBe(TEXT.trimEnd());
      } finally {
        rmSync(directory, { recursive: true, force: true });
      }
    });

    it('does not pass as "imported" when there is no script path', () => {
      const result = spawnSync(
        process.execPath,
        ['--input-type=module', '-e', `import ${JSON.stringify(SCRIPT)}`],
        {
          input: TEXT,
          encoding: 'utf8',
        },
      );
      expect(result.status).not.toBe(0);
      expect(result.stdout).toBe('');
    });
  });
});
