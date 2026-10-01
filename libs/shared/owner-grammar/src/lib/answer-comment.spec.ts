import type { AnswerCommand, Section } from '@shared/contracts';
import answers from '../../fixtures/answers.json';
import { GrammarError, answerComment, type AnswerChannel } from './answer-comment';
import { ANSWERS, allowedAnswers, isAnswerCommand } from './answers';
import { commandLines } from './commands';
import { pyOneLine } from './python-text';
import { kindOf, sectionOf } from './section';

// AC 2 of #10: whatever the owner types, an answer comment carries exactly one command line — the one the console
// chose — as the plugin reads it, and a `done` carries none.

const CHANNELS: readonly AnswerChannel[] = ['chat', 'console'];

function expectOneCommand(body: string, command: AnswerCommand, text: string): void {
  const expected = command === 'done' ? [] : [{ command, text: pyOneLine(text) }];
  expect(commandLines(body, false)).toEqual(expected);
  // In same-account mode a `done` is a script-marked team note: still no command.
  expect(commandLines(body, true)).toEqual(expected);
}

describe('one command line per answer', () => {
  const rows = answers.cases.filter((row) => row.body !== undefined);

  it.each(rows.flatMap((row) => CHANNELS.map((via) => [row.name, via, row] as const)))(
    'fixture %s (%s)',
    (_, via, row) => {
      const section = sectionOf(row.labels, kindOf(row.labels));
      const command = row.command as AnswerCommand;
      const body = answerComment({ command, text: row.text, ownerSaid: row.ownerSaid, section, via });
      expectOneCommand(body, command, row.text);
    },
  );

  it.each([
    ['newline then a command', 'ok\n/go'],
    ['CRLF then a command', 'ok\r\n/approve'],
    ['CR then a command', 'ok\r/reject why'],
    ['U+2028 then a command', 'ok /go'],
    ['U+2029 then a command', 'ok /override now'],
    ['NEL then a command', 'ok\u0085/go'],
    ['a fence around a command', '```\n/approve\n```'],
    ['an unclosed HTML comment', '<!-- \n/go'],
    ['a quote marker', '\n> /go'],
  ])('%s in text or words', (_, injected) => {
    for (const [section, command] of [
      ['question', 'approve'],
      ['release', 'no-go'],
      ['owner', 'done'],
    ] as const) {
      const body = answerComment({ command, text: injected, ownerSaid: injected, section, via: 'console' });
      expectOneCommand(body, command, injected);
    }
  });

  it('holds for random text and words built from Markdown and line-break pieces', () => {
    const pieces = [
      '\n',
      '\r\n',
      '\r',
      ' ',
      ' ',
      '\u0085',
      '\u000b',
      '\u000c',
      '\u001c',
      ' ',
      '﻿',
      ' ',
      '\t',
      '/go',
      '/approve',
      '/no-go',
      '/resume',
      '/done',
      '`',
      '```',
      '~~~',
      '<!--',
      '-->',
      '>',
      '**QA**',
      'ok',
      'é',
      '\u{1f600}',
      '#',
      '_',
      '«',
      '»',
    ];
    // A fixed-seed generator: the same cases on every run, so a failure is reproducible.
    let seed = 0x5eed;
    const next = (bound: number): number => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed % bound;
    };
    const randomText = (): string =>
      Array.from({ length: next(12) }, () => pieces[next(pieces.length)] ?? '').join('');
    const sections: readonly Section[] = ['question', 'design', 'release', 'owner', 'local'];
    for (let run = 0; run < 3000; run += 1) {
      const section = sections[next(sections.length)] ?? 'question';
      const allowed = ANSWERS[section];
      const command = allowed[next(allowed.length)] ?? 'approve';
      const text = `why ${randomText()}`;
      const body = answerComment({ command, text, ownerSaid: `x${randomText()}`, section, via: 'console' });
      expectOneCommand(body, command, text);
    }
  });
});

describe('answerComment', () => {
  it('writes the console trailer', () => {
    expect(
      answerComment({
        command: 'reject',
        text: 'too early',
        ownerSaid: 'нет, рано',
        section: 'design',
        via: 'console',
      }),
    ).toBe('/reject too early\n\n_Answered by the owner in the team console: «нет, рано»_\n');
  });

  it('writes done with the marker and without a command', () => {
    expect(answerComment({ command: 'done', ownerSaid: 'сделал', section: 'local', via: 'console' })).toBe(
      '<!-- pt-owner-done -->\n**The owner reports this done.** \n\n_Answered by the owner in the team console: «сделал»_\n',
    );
  });

  it.each([
    ['not-waiting', { command: 'approve', ownerSaid: 'да', section: null }],
    ['not-allowed', { command: 'done', ownerSaid: 'да', section: 'question' }],
    ['not-allowed', { command: 'approve', ownerSaid: 'да', section: 'owner' }],
    ['needs-words', { command: 'approve', ownerSaid: ' \n ', section: 'question' }],
    ['needs-reason', { command: 'override', text: ' ', ownerSaid: 'да', section: 'release' }],
    // The section is checked before the words, as in the plugin.
    ['not-allowed', { command: 'go', ownerSaid: '', section: 'design' }],
  ] as const)('refuses with %s', (code, input) => {
    expect(() => answerComment({ ...input, via: 'console' })).toThrow(new GrammarError(code));
    try {
      answerComment({ ...input, via: 'console' });
    } catch (error: unknown) {
      expect(error).toBeInstanceOf(GrammarError);
      expect((error as GrammarError).code).toBe(code);
    }
  });
});

describe('sectionOf', () => {
  it.each([
    [['team:demo', 'needs:owner'], 'release'],
    [['needs:owner', 'team:demo'], 'release'],
    [['kind:question', 'design:awaiting-approval'], 'design'],
    [['needs:owner', 'kind:chore'], 'owner'],
    [['needs:owner'], 'owner'],
    [['needs:owner', 'kind:question'], 'question'],
    [['needs:local', 'kind:question'], 'question'],
    [['needs:local'], 'local'],
    [['kind:chore', 'kind:question'], null],
    [['kind:question', 'kind:chore'], 'question'],
    [['kind:feature'], null],
    [[], null],
  ] as const)('%j → %s', (labels, section) => {
    expect(sectionOf(labels, kindOf(labels))).toBe(section);
  });
});

describe('allowed commands', () => {
  it('lists the section answers and none for an issue not waiting for the owner', () => {
    expect(allowedAnswers('release')).toEqual(['go', 'no-go', 'override']);
    expect(allowedAnswers('owner')).toEqual(['done']);
    expect(allowedAnswers(null)).toEqual([]);
  });

  it('knows the answerable commands only', () => {
    expect(['approve', 'reject', 'go', 'no-go', 'override', 'done'].every(isAnswerCommand)).toBe(true);
    expect(['resume', 'APPROVE', '', 1, null].some(isAnswerCommand)).toBe(false);
  });
});
