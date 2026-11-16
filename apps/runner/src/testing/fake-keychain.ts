import type { Exec, ExecOptions } from '../host/exec';

/** One `security` call as the fake saw it: argv and stdin, so a spec can assert where a secret travelled. */
export interface SecurityCall {
  readonly command: string;
  readonly args: readonly string[];
  readonly stdin: string | undefined;
}

export interface FakeKeychainOptions {
  /** The default keychain's path; null for a user with none. The file itself must exist (the adapter checks). */
  readonly defaultKeychain: string | null;
  /** A keychain that answers every item call with this exit code (36 is `errSecInteractionNotAllowed`, locked). */
  readonly failWith?: number;
  /** An `add` the fake reports as done but does not keep. */
  readonly dropAdds?: boolean;
}

/** Splits a `security -i` line the way its parser does for what the adapter writes: words and "quoted words". */
function words(line: string): string[] {
  return [...line.matchAll(/"([^"]*)"|(\S+)/g)].map((match) => match[1] ?? match[2] ?? '');
}

function valueOf(args: readonly string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  return index === -1 ? undefined : args[index + 1];
}

/**
 * A fake `/usr/bin/security` for the commands the runner uses: `default-keychain -d user`, `find-generic-password
 * -s -a -w <kc>` and `delete-generic-password -s -a <kc>` and `-i` with one `add-generic-password` on stdin. Items are keyed by keychain, service and account.
 */
export function fakeKeychain(options: FakeKeychainOptions): {
  exec: Exec;
  calls: SecurityCall[];
  items: Map<string, string>;
} {
  const calls: SecurityCall[] = [];
  const items = new Map<string, string>();
  const keyOf = (
    keychain: string | undefined,
    service: string | undefined,
    account: string | undefined,
  ): string => `${keychain ?? ''}\0${service ?? ''}\0${account ?? ''}`;

  const run = (args: readonly string[]): { code: number; stdout: string } => {
    const [verb] = args;
    if (verb === 'default-keychain') {
      return options.defaultKeychain === null
        ? { code: 50, stdout: '' }
        : { code: 0, stdout: `    "${options.defaultKeychain}"\n` };
    }
    if (options.failWith !== undefined) {
      return { code: options.failWith, stdout: '' };
    }
    const keychain = args.at(-1);
    const key = keyOf(keychain, valueOf(args, '-s'), valueOf(args, '-a'));
    if (verb === 'find-generic-password') {
      const secret = items.get(key);
      return secret === undefined ? { code: 44, stdout: '' } : { code: 0, stdout: `${secret}\n` };
    }
    if (verb === 'add-generic-password') {
      if (items.has(key)) {
        return { code: 45, stdout: '' };
      }
      if (options.dropAdds !== true) {
        items.set(key, valueOf(args, '-w') ?? '');
      }
      return { code: 0, stdout: '' };
    }
    if (verb === 'delete-generic-password') {
      return items.delete(key) ? { code: 0, stdout: '' } : { code: 44, stdout: '' };
    }
    return { code: 1, stdout: '' };
  };

  const exec: Exec = async (command: string, args: readonly string[], execOptions?: ExecOptions) => {
    calls.push({ command, args, stdin: execOptions?.stdin });
    if (command !== '/usr/bin/security') {
      return { code: 127, stdout: '' };
    }
    if (args.length === 1 && args[0] === '-i') {
      const lines = (execOptions?.stdin ?? '').split('\n').filter((line) => line.trim() !== '');
      let last = { code: 0, stdout: '' };
      for (const line of lines) {
        last = run(words(line));
      }
      return last;
    }
    return run(args);
  };

  return { exec, calls, items };
}
