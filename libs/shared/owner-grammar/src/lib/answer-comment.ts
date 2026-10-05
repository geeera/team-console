import type { AnswerCommand, AnswerRefusalCode, Section } from '@shared/contracts';
import { NEEDS_REASON, allowedAnswers } from './answers';
import { pyOneLine, pyRstrip } from './python-text';

/** The marker the team reads an owner's "done" by (`brief.DONE_MARKER`). */
export const DONE_MARKER = '<!-- pt-owner-done -->';

/**
 * Where the answer was given; only the italic trailer differs. The plugin's team chat writes `chat`; the console
 * always writes `console` (ADR 0001 decision 9). Nothing in the plugin parses the trailer.
 */
export type AnswerChannel = 'chat' | 'console';

const CHANNEL_NAMES: Readonly<Record<AnswerChannel, string>> = {
  chat: 'team chat',
  console: 'team console',
};

export class GrammarError extends Error {
  constructor(readonly code: AnswerRefusalCode) {
    super(`owner answer refused: ${code}`);
    this.name = 'GrammarError';
  }
}

export interface AnswerInput {
  readonly command: AnswerCommand;
  readonly text?: string;
  readonly ownerSaid: string;
  /** From the issue's labels (`sectionOf`), never from the client. */
  readonly section: Section | null;
  readonly via: AnswerChannel;
}

/**
 * The comment that carries the owner's answer, byte for byte what `backlog answer` posts (`brief.answer_comment`).
 * Text and words are collapsed to one line first, so nothing the owner typed can start a second command line.
 * Refusals are checked in the plugin's order: section, command, words, reason.
 */
export function answerComment(input: AnswerInput): string {
  const allowed = allowedAnswers(input.section);
  if (allowed.length === 0) {
    throw new GrammarError('not-waiting');
  }
  if (!allowed.includes(input.command)) {
    throw new GrammarError('not-allowed');
  }
  const text = pyOneLine(input.text ?? '');
  const words = pyOneLine(input.ownerSaid);
  if (words === '') {
    throw new GrammarError('needs-words');
  }
  if (NEEDS_REASON.has(input.command) && text === '') {
    throw new GrammarError('needs-reason');
  }
  const said = `_Answered by the owner in the ${CHANNEL_NAMES[input.via]}: «${words}»_`;
  if (input.command === 'done') {
    // Python's str.replace replaces every occurrence, left to right, like replaceAll.
    return `${DONE_MARKER}\n**The owner reports this done.** ${text}\n\n${said}\n`.replaceAll('  ', ' ');
  }
  return `${pyRstrip(`/${input.command} ${text}`)}\n\n${said}\n`;
}
