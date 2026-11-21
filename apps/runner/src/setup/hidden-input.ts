import type { ReadStream } from 'node:tty';

/**
 * One line from the terminal with echo off (`setup-credential --kind api-key`): raw mode, so the typed or pasted key
 * never shows and never reaches the scrollback. Refuses a stdin that is not a terminal rather than read a piped key
 * that an earlier command may also have logged.
 */

const LINE_MAX_CHARS = 4096;

export function hiddenLineReader(
  stdin: NodeJS.ReadStream,
  prompt: (text: string) => void,
): (label: string) => Promise<string> {
  return (label) =>
    new Promise((resolve, reject) => {
      if (stdin.isTTY !== true) {
        reject(new Error('the key is read from a terminal only; run setup in Terminal'));
        return;
      }
      const tty = stdin as ReadStream;
      prompt(label);
      let line = '';
      const finish = (error: Error | null): void => {
        tty.setRawMode(false);
        tty.pause();
        tty.off('data', onData);
        prompt('\n');
        if (error === null) {
          resolve(line);
        } else {
          reject(error);
        }
      };
      const onData = (chunk: Buffer): void => {
        for (const char of chunk.toString('utf8')) {
          if (char === '\r' || char === '\n') {
            finish(null);
            return;
          }
          if (char === '\u0003') {
            finish(new Error('cancelled'));
            return;
          }
          if (char === '\u007f' || char === '\b') {
            line = line.slice(0, -1);
          } else if (line.length < LINE_MAX_CHARS) {
            line += char;
          }
        }
      };
      tty.setRawMode(true);
      tty.resume();
      tty.on('data', onData);
    });
}
