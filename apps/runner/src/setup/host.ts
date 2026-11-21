import { spawn as spawnChild } from 'node:child_process';
import { constants } from 'node:fs';
import { chmod, mkdtemp, open, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { RUNNER_USER } from '../backends/user';
import { RUNNER_HOME_ENV } from '../config/config';
import { SYSTEM_PATH, hostExec, type Exec } from '../host/exec';
import { systemInstallHost } from '../install/install';
import { DOCUMENTED_DEFAULTS, bundleOf } from '../install/templates';
import type { SetupHost } from './self-check';
import type { OpenRequestChannel } from './setup';
import { isSignInUrl } from './sign-in-url';

/**
 * The real host of `setup` and `self-check` (root on macOS). The runner's own steps start as
 * `sudo -u _tcrunner -- env -i HOME=… TC_RUNNER_HOME=… PATH=<system> <node> --disable-sigusr1 <bundle> <command>`:
 * none of root's environment crosses, and with the terminal's stdio root never sees what the child prints.
 */

const SUDO = '/usr/bin/sudo';
const TERM = /^[A-Za-z0-9._+-]{1,64}$/;
const USER_NAME = /^[a-z_][a-z0-9_.-]{0,31}$/;
/** The first uid macOS gives a person's account; below it are system users. */
const FIRST_LOGIN_UID = 501;

export interface SetupHostOptions {
  readonly uid: number;
  readonly homeDir: string;
  /** The installed prefix whose bundle `_tcrunner` runs. */
  readonly prefix: string;
  readonly node: string;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly exec?: Exec;
}

function runnerArgv(options: SetupHostOptions, args: readonly string[]): string[] {
  const home = DOCUMENTED_DEFAULTS.home;
  const term = options.env['TERM'];
  return [
    '-n',
    '-u',
    RUNNER_USER,
    '--',
    '/usr/bin/env',
    '-i',
    `HOME=${home}`,
    `${RUNNER_HOME_ENV}=${home}`,
    `PATH=${SYSTEM_PATH}`,
    ...(term !== undefined && TERM.test(term) ? [`TERM=${term}`] : []),
    options.node,
    '--disable-sigusr1',
    bundleOf(options.prefix),
    ...args,
  ];
}

export function systemSetupHost(options: SetupHostOptions): SetupHost {
  const exec = options.exec ?? hostExec;
  const base = systemInstallHost({ platform: 'darwin', uid: options.uid, homeDir: options.homeDir, exec });
  return {
    ...base,
    runAsRunner: (args) =>
      new Promise((resolve, reject) => {
        const child = spawnChild(SUDO, runnerArgv(options, args), { stdio: 'inherit', env: { PATH: SYSTEM_PATH } });
        child.once('error', reject);
        child.once('close', (code) => resolve(code ?? 1));
      }),
    queryAsRunner: (args) => exec(SUDO, runnerArgv(options, args)),
    list: async (path) => {
      try {
        return await readdir(path);
      } catch (error: unknown) {
        if (error instanceof Error && 'code' in error && (error.code === 'ENOENT' || error.code === 'ENOTDIR')) {
          return null;
        }
        throw error;
      }
    },
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    now: () => new Date(),
  };
}

/**
 * A root-owned 0711 directory holding one file `_tcrunner` may append to and nothing else: the runner's user cannot
 * add, rename or link anything there, and root reads through the descriptor it opened first.
 */
export async function openRequestChannel(tmpRoot: string, exec: Exec = hostExec): Promise<OpenRequestChannel> {
  const { code, stdout } = await exec('/usr/bin/id', ['-u', RUNNER_USER]);
  if (code !== 0 || !/^\d+$/.test(stdout.trim())) {
    throw new Error(`could not resolve ${RUNNER_USER}`);
  }
  const dir = await mkdtemp(join(tmpRoot, 'tcr-open-'));
  await chmod(dir, 0o711);
  const path = join(dir, 'requests');
  const created = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  await created.chown(Number(stdout.trim()), -1);
  await created.close();
  const reader = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  let offset = 0;
  return {
    path,
    take: async () => {
      // A request is one URL; a child that writes more gets it ignored, never buffered without bound.
      const buffer = Buffer.alloc(16 * 1024);
      const { bytesRead } = await reader.read(buffer, 0, buffer.length, offset);
      offset += bytesRead;
      return buffer.subarray(0, bytesRead).toString('utf8');
    },
    close: async () => {
      await reader.close();
      await rm(dir, { recursive: true, force: true });
    },
  };
}

/**
 * Opens a sign-in page in the browser of the user who ran `sudo` (R-TOK-2): the URL judged again, `SUDO_USER` a login
 * account (uid 501 or above, never root), `open` run through `execFile` with no shell. Anything else is ignored: the
 * CLI prints the URL as well, so the operator can open it by hand.
 */
export function userOpener(env: Readonly<Record<string, string | undefined>>, exec: Exec = hostExec) {
  return async (url: string): Promise<void> => {
    const user = env['SUDO_USER'] ?? '';
    const uid = Number(env['SUDO_UID'] ?? 'NaN');
    if (!isSignInUrl(url) || !USER_NAME.test(user) || !Number.isInteger(uid) || uid < FIRST_LOGIN_UID) {
      return;
    }
    await exec(SUDO, ['-n', '-u', user, '--', '/usr/bin/open', url]);
  };
}
