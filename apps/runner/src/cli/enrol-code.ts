import { ENROL_CODE_ENV } from '@shared/contracts';
import { ENROLMENT_CODE_PREFIX } from '@shared/redaction';
import { EnrolUsageError } from './enrol';

/**
 * #582: the one-time code never has to be an argv value, which any local user reads with `ps` while enrol runs.
 * `TC_ENROL_CODE` (what Settings › Runners shows) or `--code -` (one line of stdin, for `sudo`, which drops the
 * caller's environment) keep it out of argv; `--code <value>` stays for fixtures.
 */
export const ENROL_CODE_STDIN = '-';

/** A code is ~50 bytes; a longer first line is not a code, and reading on would buffer whatever was piped in. */
const CODE_LINE_MAX_BYTES = 1024;

export type ReadCodeLine = () => Promise<string>;

/**
 * The first line of `input`, trimmed; at most `maxBytes`, whatever follows it is never read. `flag` names the option
 * that asked for stdin, for the refusal of an overlong line.
 */
export async function readFirstLine(
  input: AsyncIterable<string | Buffer>,
  maxBytes: number = CODE_LINE_MAX_BYTES,
  flag = '--code -',
): Promise<string> {
  let text = '';
  for await (const chunk of input) {
    text += typeof chunk === 'string' ? chunk : chunk.toString('utf8');
    const end = text.indexOf('\n');
    if (end !== -1) {
      return text.slice(0, end).trim();
    }
    if (Buffer.byteLength(text) > maxBytes) {
      throw new EnrolUsageError(`${flag} reads one line of at most ${String(maxBytes)} bytes from stdin`);
    }
  }
  return text.trim();
}

/** The code from stdin; on a terminal a prompt goes to stderr first, so stdout stays the command's own output. */
export function stdinCodeReader(
  stdin: AsyncIterable<string | Buffer> & { readonly isTTY?: boolean },
  prompt: (text: string) => void,
): ReadCodeLine {
  return async () => {
    if (stdin.isTTY === true) {
      prompt('Paste the one-time code (or the whole command) from Settings › Runners and press Enter: ');
    }
    return await readFirstLine(stdin);
  };
}

/** A code inside pasted text: not glued to a longer word on the left, as long as it runs on the right. */
const CODE_IN_TEXT = new RegExp(`(?<![A-Za-z0-9_-])${ENROLMENT_CODE_PREFIX}[A-Za-z0-9_-]{20,}`, 'g');

/**
 * #772: Settings › Runners shows the whole `TC_ENROL_CODE=tce_… team-console-runner enrol …` line, and that is what
 * gets pasted at the prompt. The code is taken out of it when the text holds exactly one; none or several is refused.
 * The refusal never repeats the text, which holds the code.
 */
export function extractEnrolCode(text: string): string {
  const found = text.match(CODE_IN_TEXT) ?? [];
  if (found.length === 1 && found[0] !== undefined) {
    return found[0];
  }
  throw new EnrolUsageError(
    found.length === 0
      ? `no one-time ${ENROLMENT_CODE_PREFIX}… code in what was given: paste the code or the command from Settings › Runners`
      : `${String(found.length)} ${ENROLMENT_CODE_PREFIX}… codes in what was given: paste one code only`,
  );
}

/**
 * Where the code comes from: `--code -` reads stdin, `--code <value>` is the value, no `--code` reads
 * `TC_ENROL_CODE`. Both a flag and the variable is refused: which one won would be a guess. `undefined` for none.
 * Whatever the source, the code is extracted from it (`extractEnrolCode`).
 */
export async function enrolCodeOf(
  flag: string | undefined,
  env: Readonly<Record<string, string | undefined>>,
  readCodeLine: ReadCodeLine | undefined,
): Promise<string | undefined> {
  const fromEnv = env[ENROL_CODE_ENV]?.trim() ?? '';
  const hasEnv = fromEnv !== '';
  if (flag !== undefined && hasEnv) {
    throw new EnrolUsageError(`give the code once: either --code or ${ENROL_CODE_ENV}, not both`);
  }
  if (flag === ENROL_CODE_STDIN) {
    if (readCodeLine === undefined) {
      throw new EnrolUsageError('--code - needs stdin, which this runner cannot read');
    }
    return extractEnrolCode(await readCodeLine());
  }
  const given = flag ?? (hasEnv ? fromEnv : undefined);
  return given === undefined ? undefined : extractEnrolCode(given);
}
