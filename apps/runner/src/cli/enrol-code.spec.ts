import { Readable } from 'node:stream';
import { ENROL_CODE_ENV } from '@shared/contracts';
import { EnrolUsageError } from './enrol';
import { enrolCodeOf, extractEnrolCode, readFirstLine, stdinCodeReader } from './enrol-code';

const CODE = `tce_${'C'.repeat(43)}`;

describe('readFirstLine', () => {
  it('returns the first line, trimmed, and leaves the rest unread', async () => {
    expect(await readFirstLine(Readable.from([`  ${CODE}\r\nsecond line\n`]))).toBe(CODE);
  });

  it('joins a line split across chunks', async () => {
    expect(await readFirstLine(Readable.from([Buffer.from('tce_'), Buffer.from(`${'C'.repeat(43)}\n`)]))).toBe(
      CODE,
    );
  });

  it('takes a last line without a newline, and empty input as empty', async () => {
    expect(await readFirstLine(Readable.from([CODE]))).toBe(CODE);
    expect(await readFirstLine(Readable.from([]))).toBe('');
  });

  it('refuses a first line longer than the cap instead of buffering it', async () => {
    await expect(readFirstLine(Readable.from(['x'.repeat(40), 'y'.repeat(40)]), 64)).rejects.toBeInstanceOf(
      EnrolUsageError,
    );
  });

  it('names the flag that asked for stdin in that refusal', async () => {
    await expect(readFirstLine(Readable.from(['x'.repeat(80)]), 64, '--request-token -')).rejects.toThrow(
      '--request-token - reads one line of at most 64 bytes from stdin',
    );
  });
});

describe('stdinCodeReader', () => {
  it('prompts on a terminal, on the prompt stream only', async () => {
    const prompts: string[] = [];
    const tty = Object.assign(Readable.from([`${CODE}\n`]), { isTTY: true });
    expect(await stdinCodeReader(tty, (text) => prompts.push(text))()).toBe(CODE);
    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toContain('one-time code');
  });

  it('reads a pipe without a prompt', async () => {
    const prompts: string[] = [];
    expect(await stdinCodeReader(Readable.from([`${CODE}\n`]), (text) => prompts.push(text))()).toBe(CODE);
    expect(prompts).toEqual([]);
  });
});

describe('enrolCodeOf', () => {
  const stdin = async (): Promise<string> => await Promise.resolve(CODE);

  it('reads stdin for --code -', async () => {
    expect(await enrolCodeOf('-', {}, stdin)).toBe(CODE);
  });

  it(`reads ${ENROL_CODE_ENV} when there is no --code, trimmed`, async () => {
    expect(await enrolCodeOf(undefined, { [ENROL_CODE_ENV]: ` ${CODE}\n` }, undefined)).toBe(CODE);
  });

  it('keeps --code <value> for fixtures', async () => {
    expect(await enrolCodeOf(CODE, {}, undefined)).toBe(CODE);
  });

  it('is undefined with no source, an empty variable counting as none', async () => {
    expect(await enrolCodeOf(undefined, {}, stdin)).toBeUndefined();
    expect(await enrolCodeOf(undefined, { [ENROL_CODE_ENV]: '' }, stdin)).toBeUndefined();
  });

  it.each([
    ['--code <value>', CODE],
    ['--code -', '-'],
  ])(`refuses %s together with ${ENROL_CODE_ENV}`, async (_, flag) => {
    let read = false;
    const reader = async (): Promise<string> => {
      read = true;
      return await Promise.resolve(CODE);
    };
    await expect(enrolCodeOf(flag, { [ENROL_CODE_ENV]: CODE }, reader)).rejects.toThrow(/not both/);
    expect(read).toBe(false);
  });

  it('refuses --code - when there is no stdin to read', async () => {
    await expect(enrolCodeOf('-', {}, undefined)).rejects.toBeInstanceOf(EnrolUsageError);
  });

  // #772: the owner pasted the whole line Settings › Runners shows at the --code - prompt.
  const LINE = `TC_ENROL_CODE=${CODE} team-console-runner enrol --url https://team-console-dev.example.dev`;

  it('takes the code out of the whole command pasted at the prompt', async () => {
    expect(await enrolCodeOf('-', {}, async () => await Promise.resolve(LINE))).toBe(CODE);
  });

  it(`takes the code out of ${ENROL_CODE_ENV} holding the whole command`, async () => {
    expect(await enrolCodeOf(undefined, { [ENROL_CODE_ENV]: LINE }, undefined)).toBe(CODE);
  });
});

describe('extractEnrolCode', () => {
  const OTHER = `tce_${'D'.repeat(43)}`;

  it.each([
    ['the bare code', CODE],
    ['the command line', `TC_ENROL_CODE=${CODE} team-console-runner enrol --url https://console.example`],
    ['a quoted code', `"${CODE}"`],
    ['a code inside prompt noise', `$ export TC_ENROL_CODE='${CODE}';`],
  ])('finds exactly one code in %s', (_, text) => {
    expect(extractEnrolCode(text)).toBe(CODE);
  });

  it.each([
    ['two codes', `${CODE} ${OTHER}`, /2 tce_… codes in what was given: paste one code only/],
    ['the same code twice', `TC_ENROL_CODE=${CODE} ${CODE}`, /2 tce_… codes/],
    ['no code', 'team-console-runner enrol --url https://console.example', /no one-time tce_… code/],
    ['an empty line', '', /no one-time tce_… code/],
    ['a code too short', 'tce_abc', /no one-time tce_… code/],
    ['a code glued to a word', `xtce_${'C'.repeat(43)}`, /no one-time tce_… code/],
    ['a job token', `tcj_${'C'.repeat(43)}`, /no one-time tce_… code/],
  ])('refuses %s without repeating what was given', (_, text, message) => {
    let error: unknown;
    try {
      extractEnrolCode(text);
    } catch (caught: unknown) {
      error = caught;
    }
    expect(error).toBeInstanceOf(EnrolUsageError);
    expect((error as Error).message).toMatch(message);
    expect((error as Error).message).not.toContain('C'.repeat(20));
    expect((error as Error).message).not.toContain('D'.repeat(20));
  });
});
