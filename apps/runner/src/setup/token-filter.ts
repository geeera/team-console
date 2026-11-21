import { StringDecoder } from 'node:string_decoder';
import { ANTHROPIC_OAUTH_TOKEN_PREFIX } from '@shared/redaction';

/**
 * The stream filter between `claude setup-token` and the operator's terminal (#634 PR 2, S5 of the security note,
 * R-TOK-1). The CLI prints its sign-in URL and prompts, then the token, then a few lines of advice. Everything before
 * the token reaches the terminal; nothing of the token may, on stdout or stderr, whatever the CLI does to its output
 * (colour, `\r` redraws, wrapping, a prompt without a newline that splits the token at a chunk boundary).
 *
 * So the filter keeps state instead of judging lines: matching runs on the decoded text with escape sequences and
 * control characters removed, and once `sk-` shows up on either stream, nothing more is forwarded from either until
 * the child exits. Before that, text is flushed as it arrives except a trailing `s` or `sk`, the only tails that
 * could still become `sk-`. Capture is strict and fails closed: exactly one well-formed setup-token, or nothing.
 */

export type StreamName = 'stdout' | 'stderr';

export interface FilterSinks {
  readonly stdout: (text: string) => void;
  readonly stderr: (text: string) => void;
}

/** Why nothing was captured; the reasons name shapes, never a value. */
export type CaptureRefusal = 'no-token' | 'two-tokens' | 'api-key' | 'malformed' | 'wrapped' | 'overflow';

export type CaptureOutcome =
  | { readonly kind: 'token'; readonly value: string }
  | { readonly kind: 'refused'; readonly reason: CaptureRefusal };

/** What may start any Anthropic key; seeing it anywhere stops all forwarding. */
const KEY_START = 'sk-';
const SETUP_TOKEN = new RegExp(`^${ANTHROPIC_OAUTH_TOKEN_PREFIX}01-[A-Za-z0-9_-]{20,4096}$`);
const API_KEY_START = 'sk-ant-api';
/** The wide class for "this run of text is one value" (printable ASCII without space). */
const VALUE_RUN = /^[\x21-\x7e]+/;
/** A line that holds nothing but token characters: the tail of a token the CLI wrapped. */
const TOKEN_FRAGMENT_LINE = /^[ \t]*[A-Za-z0-9_-]+[ \t]*$/;
/** More output after the token than any CLI prints; the rest is dropped and the capture refused. */
const TAIL_MAX_CHARS = 64 * 1024;
/** An escape sequence longer than this is not one the CLI draws with; it is dropped whole. */
const ESCAPE_MAX_CHARS = 4096;

/** CSI (`ESC [ … final`), OSC (`ESC ] … BEL | ESC \`), charset (`ESC ( x`) and two-byte escapes. */
const COMPLETE_ESCAPE = /^\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07\x1b]*(?:\x07|\x1b\\)|[()#][0-9A-Za-z]|[@-Z\\-_])/;
/** An escape that may still complete with more input. */
const PARTIAL_ESCAPE = /^\x1b(?:\[[0-?]*[ -/]*|\][^\x07\x1b]*\x1b?|[()#])?$/;
/** Control and invisible format characters a redraw can hide between `s`, `k` and `-`; newline and tab stay. */
const INVISIBLE = /[\p{Cc}\p{Cf}]/u;

interface StreamState {
  readonly decoder: StringDecoder;
  /** Raw text not cleaned yet: an escape sequence or a `\r` that the next chunk may complete. */
  raw: string;
  /** Cleaned text held back: a trailing `s` or `sk`. */
  held: string;
  /** Everything from the first `sk-` on: matched at the end, never forwarded. */
  tail: string;
}

/**
 * Cleans `raw` for matching: escapes and invisible characters removed, `\r\n` and a lone `\r` made a newline. Returns
 * the clean text and the raw rest that may still complete (empty when `final`).
 */
export function cleanTerminalText(raw: string, final: boolean): { clean: string; rest: string } {
  let clean = '';
  let index = 0;
  while (index < raw.length) {
    const char = raw.charAt(index);
    if (char === '\x1b') {
      const rest = raw.slice(index);
      const complete = COMPLETE_ESCAPE.exec(rest);
      if (complete !== null) {
        index += complete[0].length;
        continue;
      }
      if (!final && PARTIAL_ESCAPE.test(rest) && rest.length <= ESCAPE_MAX_CHARS) {
        return { clean, rest };
      }
      // Not an escape the filter knows, or one that never ends: the ESC goes and the rest is read as text.
      index += 1;
      continue;
    }
    if (char === '\r') {
      if (index + 1 === raw.length && !final) {
        return { clean, rest: char };
      }
      clean += '\n';
      index += raw.charAt(index + 1) === '\n' ? 2 : 1;
      continue;
    }
    if (char !== '\n' && char !== '\t' && INVISIBLE.test(char)) {
      index += 1;
      continue;
    }
    clean += char;
    index += 1;
  }
  return { clean, rest: '' };
}

/** How much of the end of `text` could still grow into `sk-`. */
function heldTailLength(text: string): number {
  if (text.endsWith('sk')) {
    return 2;
  }
  return text.endsWith('s') ? 1 : 0;
}

type Occurrence = 'token' | 'api-key' | 'malformed' | 'wrapped';

function judgeOccurrence(tail: string, start: number): { kind: Occurrence; value: string } {
  const value = VALUE_RUN.exec(tail.slice(start))?.[0] ?? '';
  if (value.startsWith(API_KEY_START)) {
    return { kind: 'api-key', value };
  }
  if (!SETUP_TOKEN.test(value)) {
    return { kind: 'malformed', value };
  }
  const after = tail.slice(start + value.length);
  if (after.startsWith('\n')) {
    const nextLine = after.slice(1).split('\n', 1)[0] ?? '';
    // A line that starts another key is judged as its own occurrence, not as this one's tail.
    if (TOKEN_FRAGMENT_LINE.test(nextLine) && !nextLine.includes(KEY_START)) {
      return { kind: 'wrapped', value };
    }
  } else if (after !== '' && !/^[ \t]/.test(after)) {
    // A token glued to something outside the class (a quote, say) is still one value; anything else is a guess.
    return { kind: 'malformed', value };
  }
  return { kind: 'token', value };
}

/** Exactly one distinct well-formed setup-token and nothing else that looks like a key, or a refusal. */
export function judgeTails(tails: readonly string[], overflowed: boolean): CaptureOutcome {
  if (overflowed) {
    return { kind: 'refused', reason: 'overflow' };
  }
  const tokens = new Set<string>();
  let problem: CaptureRefusal | null = null;
  for (const tail of tails) {
    for (let at = tail.indexOf(KEY_START); at !== -1; at = tail.indexOf(KEY_START, at + KEY_START.length)) {
      const occurrence = judgeOccurrence(tail, at);
      if (occurrence.kind === 'token') {
        tokens.add(occurrence.value);
      } else {
        problem ??= occurrence.kind;
      }
    }
  }
  if (problem !== null) {
    return { kind: 'refused', reason: problem };
  }
  if (tokens.size > 1) {
    return { kind: 'refused', reason: 'two-tokens' };
  }
  const [value] = tokens;
  return value === undefined ? { kind: 'refused', reason: 'no-token' } : { kind: 'token', value };
}

export class SetupTokenFilter {
  private readonly streams: Record<StreamName, StreamState> = {
    stdout: { decoder: new StringDecoder('utf8'), raw: '', held: '', tail: '' },
    stderr: { decoder: new StringDecoder('utf8'), raw: '', held: '', tail: '' },
  };
  private suppressed = false;
  private overflowed = false;
  private ended = false;

  constructor(private readonly sinks: FilterSinks) {}

  /** Whether a key start was seen: from here on nothing is forwarded. */
  get isSuppressing(): boolean {
    return this.suppressed;
  }

  write(name: StreamName, chunk: Buffer | string): void {
    if (this.ended) {
      return;
    }
    const state = this.streams[name];
    const text = typeof chunk === 'string' ? chunk : state.decoder.write(chunk);
    this.take(name, state.raw + text, false);
  }

  /** Flushes what is safe, then judges what was held back. Call once, after the child exited. */
  end(): CaptureOutcome {
    if (!this.ended) {
      for (const name of ['stdout', 'stderr'] as const) {
        const state = this.streams[name];
        this.take(name, state.raw + state.decoder.end(), true);
      }
      this.ended = true;
    }
    return judgeTails([this.streams.stdout.tail, this.streams.stderr.tail], this.overflowed);
  }

  private take(name: StreamName, raw: string, final: boolean): void {
    const state = this.streams[name];
    const { clean, rest } = cleanTerminalText(raw, final);
    state.raw = rest;
    if (this.suppressed) {
      this.keep(state, clean);
      return;
    }
    const text = state.held + clean;
    state.held = '';
    const start = text.indexOf(KEY_START);
    if (start !== -1) {
      this.forward(name, text.slice(0, start));
      this.suppress();
      this.keep(state, text.slice(start));
      return;
    }
    const hold = final ? 0 : heldTailLength(text);
    this.forward(name, text.slice(0, text.length - hold));
    state.held = text.slice(text.length - hold);
  }

  /** Both streams stop together: what the other one held back is kept with the tail, never forwarded. */
  private suppress(): void {
    this.suppressed = true;
    for (const state of Object.values(this.streams)) {
      this.keep(state, state.held);
      state.held = '';
    }
  }

  private keep(state: StreamState, text: string): void {
    if (state.tail.length + text.length > TAIL_MAX_CHARS) {
      this.overflowed = true;
      return;
    }
    state.tail += text;
  }

  private forward(name: StreamName, text: string): void {
    if (text !== '') {
      this.sinks[name](text);
    }
  }
}
