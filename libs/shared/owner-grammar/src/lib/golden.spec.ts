import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { AnswerCommand } from '@shared/contracts';
import answers from '../../fixtures/answers.json';
import commands from '../../fixtures/commands.json';
import { GrammarError, answerComment } from './answer-comment';
import { commandLines, isTeamNote } from './commands';
import { isPyWhitespace, pyOneLine } from './python-text';
import { kindOf, sectionOf } from './section';

// Golden fixtures written by the vendored plugin itself (fixtures/generate.py runs the real `backlog answer` and
// `commands.command_lines`); the port must agree with every row byte for byte.

const ROOT = resolve(import.meta.dirname, '../../../../..');
const PLUGIN = resolve(ROOT, '.claude/product-team');

interface AnswerCase {
  readonly name: string;
  readonly labels: string[];
  readonly state: string;
  readonly command: string;
  readonly text: string;
  readonly ownerSaid: string;
  readonly body?: string;
  readonly error?: string;
}

const answerCases: readonly AnswerCase[] = answers.cases;

/** What the console route does before the grammar: a closed issue is refused first, like `backlog answer`. */
function answerLike(row: AnswerCase): { body: string } | { error: string } {
  if (row.state !== 'open') {
    return { error: 'closed' };
  }
  const section = sectionOf(row.labels, kindOf(row.labels));
  try {
    return {
      body: answerComment({
        command: row.command as AnswerCommand,
        text: row.text,
        ownerSaid: row.ownerSaid,
        section,
        via: 'chat',
      }),
    };
  } catch (error: unknown) {
    if (error instanceof GrammarError) {
      return { error: error.code };
    }
    throw error;
  }
}

describe('fixtures match the vendored plugin', () => {
  it.each([
    ['answers.json', answers.plugin],
    ['commands.json', commands.plugin],
  ])(
    '%s was generated from the vendored plugin as it is now (else: regenerate the fixtures)',
    (_, plugin) => {
      const manifest = JSON.parse(readFileSync(resolve(PLUGIN, '.claude-plugin/plugin.json'), 'utf8')) as {
        version: string;
      };
      expect(plugin.version).toBe(manifest.version);
      for (const [path, digest] of Object.entries(plugin.sources)) {
        const actual = createHash('sha256')
          .update(readFileSync(resolve(PLUGIN, path)))
          .digest('hex');
        expect({ path, digest: actual }).toEqual({ path, digest });
      }
    },
  );
});

describe('answerComment against `backlog answer`', () => {
  it('covers every refusal and every section', () => {
    const outcomes = new Set(answerCases.map((row) => row.error ?? 'body'));
    expect([...outcomes].sort()).toEqual([
      'body',
      'closed',
      'needs-reason',
      'needs-words',
      'not-allowed',
      'not-waiting',
    ]);
  });

  it.each(answerCases.map((row) => [row.name, row] as const))('%s', (_, row) => {
    expect(answerLike(row)).toEqual(row.body === undefined ? { error: row.error } : { body: row.body });
  });

  it('writes the console trailer as the one intended difference', () => {
    const row = answerCases.find((candidate) => candidate.name === 'question approve');
    if (row?.body === undefined) {
      throw new Error('fixture "question approve" is missing');
    }
    const body = answerComment({
      command: 'approve',
      text: row.text,
      ownerSaid: row.ownerSaid,
      section: 'question',
      via: 'console',
    });
    expect(body).toBe(row.body.replace('in the team chat:', 'in the team console:'));
  });
});

describe('commandLines / isTeamNote against `commands.command_lines`', () => {
  it.each(commands.cases.map((row, index) => [index, JSON.stringify(row.body).slice(0, 60), row] as const))(
    '#%i %s',
    (_, __, row) => {
      const pairs = (sameAccount: boolean): string[][] =>
        commandLines(row.body, sameAccount).map((line) => [line.command, line.text]);
      expect(isTeamNote(row.body)).toBe(row.teamNote);
      expect(pairs(true)).toEqual(row.sameAccount);
      expect(pairs(false)).toEqual(row.app);
    },
  );
});

describe("Python's whitespace", () => {
  it('is exactly str.isspace() over every code point', () => {
    const expected = new Set(answers.whitespace);
    const mismatches: number[] = [];
    for (let code = 0; code <= 0xffff; code += 1) {
      if (isPyWhitespace(String.fromCharCode(code)) !== expected.has(code)) {
        mismatches.push(code);
      }
    }
    expect(mismatches).toEqual([]);
    expect(answers.whitespace.every((code) => code <= 0xffff)).toBe(true);
  });

  it.each([
    ['NBSP collapses', 'a b', 'a b'],
    ['U+001C collapses (not JS \\s)', 'a\u001cb', 'a b'],
    ['U+0085 collapses (not JS \\s)', 'a\u0085b', 'a b'],
    ['U+2028 collapses', 'a b', 'a b'],
    ['U+FEFF is kept (JS \\s would drop it)', '﻿a﻿', '﻿a﻿'],
    ['CRLF and a tab collapse', 'a\r\n\tb', 'a b'],
    ['ends are trimmed', ' \n a  b \t', 'a b'],
  ])('%s', (_, input, output) => {
    expect(pyOneLine(input)).toBe(output);
  });
});
