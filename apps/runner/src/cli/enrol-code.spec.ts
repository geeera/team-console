import { Readable } from 'node:stream';
import { ENROL_CODE_ENV } from '@shared/contracts';
import { EnrolUsageError } from './enrol';
import { enrolCodeOf, readFirstLine, stdinCodeReader } from './enrol-code';

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
});
