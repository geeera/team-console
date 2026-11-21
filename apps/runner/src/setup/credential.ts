import { spawn as spawnChild } from 'node:child_process';
import { constants } from 'node:fs';
import { mkdtemp, open, rm } from 'node:fs/promises';
import { join } from 'node:path';
import type { Readable } from 'node:stream';
import { ANTHROPIC_OAUTH_TOKEN_PREFIX } from '@shared/redaction';
import { updateRunnerConfig, type RunnerConfig } from '../config/config';
import { ensurePrivateDir, lstatOrNull, replacePrivateFile } from '../config/private-files';
import { CREDENTIALS_DIR, CREDENTIAL_BACKENDS, type CredentialConfig } from '../env/credential';
import { isSignInUrl } from './sign-in-url';
import { SetupTokenFilter, type CaptureRefusal } from './token-filter';

/**
 * `team-console-runner setup-credential --kind setup-token|api-key [--replace]` (#634 PR 2, architect note section 3,
 * R-TOK-1…3). Runs as the runner's user (`setup` starts it with `sudo -u _tcrunner env -i …`), never as root, and
 * makes no network call. `setup-token` runs `claude setup-token` with the operator's terminal on stdin, its stdout and
 * stderr through `SetupTokenFilter`, and a fresh 0700 `HOME` that is removed afterwards, so the CLI leaves no login
 * state in the runner's home where the job user can traverse. `api-key` reads one line with echo off. Either way the
 * value is written once (`replacePrivateFile`, 0600) and only its length is ever reported.
 */

export const CREDENTIAL_KINDS_SET_UP = ['setup-token', 'api-key'] as const;
export type SetUpCredentialKind = (typeof CREDENTIAL_KINDS_SET_UP)[number];
export const isSetUpCredentialKind = (value: unknown): value is SetUpCredentialKind =>
  (CREDENTIAL_KINDS_SET_UP as readonly unknown[]).includes(value);

export const CREDENTIAL_FILE_OF: Readonly<Record<SetUpCredentialKind, string>> = {
  'setup-token': `${CREDENTIALS_DIR}/claude-setup-token`,
  'api-key': `${CREDENTIALS_DIR}/anthropic.key`,
};

type FileCredential = Extract<CredentialConfig, { readonly file: string }>;

export class CredentialSetupError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CredentialSetupError';
  }
}

/** The CLI process as the capture needs it: its two output streams and its end. */
export interface ClaudeProcess {
  readonly stdout: Readable;
  readonly stderr: Readable;
  readonly exited: Promise<number | null>;
}

/** Starts `claude setup-token`; stdin is the operator's terminal, so the CLI's own prompts work as they would. */
export type SpawnClaude = (command: string, args: readonly string[], env: Readonly<Record<string, string>>, cwd: string) => ClaudeProcess;

export interface CredentialSetupDeps {
  readonly home: string;
  readonly config: RunnerConfig;
  /** What reaches the operator's terminal: the CLI's filtered output, then this command's own lines. */
  readonly terminal: { readonly stdout: (text: string) => void; readonly stderr: (text: string) => void };
  readonly log: (line: string) => void;
  /** Where the fresh `HOME` of the CLI is made: the system's temporary directory, never the runner's home. */
  readonly tmpRoot: string;
  readonly spawnClaude: SpawnClaude;
  /** `api-key`: one line, read with echo off. */
  readonly readHiddenLine?: (prompt: string) => Promise<string>;
  /** A file `setup` (root) reads to open the sign-in page for the operator; the URL is all that is written there. */
  readonly openRequests?: string;
  /** `TERM` of the operator's terminal, so the CLI draws as usual. */
  readonly term?: string;
}

export interface CredentialSetupOptions {
  readonly kind: SetUpCredentialKind;
  readonly replace: boolean;
  /** The Claude Code CLI as the toolchain names it (an absolute path) and the PATH it runs with. */
  readonly claude: string;
  readonly path: string;
}

const API_KEY = /^sk-ant-api[0-9]{2}-[A-Za-z0-9_-]{20,4096}$/;
const TERM = /^[A-Za-z0-9._+-]{1,64}$/;
/** `ulimit -c 0`: no core dump of the CLI's memory, which holds the token while it prints it. */
const NO_CORE_LAUNCHER = ['-c', 'ulimit -c 0; exec "$0" "$@"'];

const REFUSALS: Readonly<Record<CaptureRefusal, string>> = {
  'no-token': 'no token was captured',
  'two-tokens': 'two different tokens were printed',
  'api-key': 'an API key was printed where a setup-token belongs',
  malformed: 'something like a key was printed, but not one setup-token',
  wrapped: 'the token was printed across lines',
  overflow: 'the CLI printed far more than expected after the token',
};

/** The real `claude`: stdin inherited, stdout and stderr piped into this process only. */
export const hostSpawnClaude: SpawnClaude = (command, args, env, cwd) => {
  const child = spawnChild(command, [...args], { stdio: ['inherit', 'pipe', 'pipe'], env: { ...env }, cwd });
  const exited = new Promise<number | null>((resolve) => {
    child.once('close', (code) => resolve(code));
    child.once('error', () => resolve(null));
  });
  return { stdout: child.stdout, stderr: child.stderr, exited };
};

/** Lines of forwarded output, scanned for the sign-in URL; nothing of a suppressed stream ever reaches it. */
class SignInLinks {
  private partial = '';
  private readonly seen = new Set<string>();

  constructor(private readonly request: (url: string) => Promise<void>) {}

  async take(text: string): Promise<void> {
    const lines = (this.partial + text).split('\n');
    this.partial = lines.pop() ?? '';
    for (const line of lines) {
      for (const [url] of line.matchAll(/https:\/\/[^\s"'<>]+/g)) {
        if (!this.seen.has(url) && isSignInUrl(url)) {
          this.seen.add(url);
          await this.request(url);
        }
      }
    }
  }
}

async function appendOpenRequest(path: string, url: string): Promise<void> {
  // The file is root's to create; the runner's user only appends to it, never through a link.
  const handle = await open(path, constants.O_WRONLY | constants.O_APPEND | constants.O_NOFOLLOW);
  try {
    await handle.write(`${url}\n`);
  } finally {
    await handle.close();
  }
}

async function captureSetupToken(deps: CredentialSetupDeps, options: CredentialSetupOptions): Promise<string> {
  const cliHome = await mkdtemp(join(deps.tmpRoot, 'tcr-claude-'));
  try {
    const env: Record<string, string> = { HOME: cliHome, PATH: options.path };
    if (deps.term !== undefined && TERM.test(deps.term)) {
      env['TERM'] = deps.term;
    }
    const pending: Promise<void>[] = [];
    const links =
      deps.openRequests === undefined
        ? null
        : new SignInLinks((url) => appendOpenRequest(deps.openRequests ?? '', url));
    const filter = new SetupTokenFilter({
      stdout: (text) => {
        deps.terminal.stdout(text);
        if (links !== null) {
          pending.push(links.take(text));
        }
      },
      stderr: (text) => deps.terminal.stderr(text),
    });
    const child = deps.spawnClaude('/bin/sh', [...NO_CORE_LAUNCHER, options.claude, 'setup-token'], env, cliHome);
    const drained = Promise.all(
      (['stdout', 'stderr'] as const).map(
        (name) =>
          new Promise<void>((resolve, reject) => {
            child[name].on('data', (chunk: Buffer) => filter.write(name, chunk));
            child[name].once('end', resolve);
            child[name].once('error', reject);
          }),
      ),
    );
    const [code] = await Promise.all([child.exited, drained]);
    const outcome = filter.end();
    await Promise.all(pending);
    if (code !== 0) {
      throw new CredentialSetupError(`claude setup-token exited ${String(code)}; nothing was written`);
    }
    if (outcome.kind === 'refused') {
      throw new CredentialSetupError(`${REFUSALS[outcome.reason]}; nothing was written`);
    }
    return outcome.value;
  } finally {
    await rm(cliHome, { recursive: true, force: true });
  }
}

async function readApiKey(deps: CredentialSetupDeps): Promise<string> {
  if (deps.readHiddenLine === undefined) {
    throw new CredentialSetupError('--kind api-key reads the key from a terminal, and this process has none');
  }
  const value = (await deps.readHiddenLine('Anthropic API key (not shown as you type): ')).trim();
  if (value.startsWith(ANTHROPIC_OAUTH_TOKEN_PREFIX)) {
    throw new CredentialSetupError('that is a Claude subscription login, not an API key; nothing was written');
  }
  if (!API_KEY.test(value)) {
    throw new CredentialSetupError('that is not an Anthropic API key (sk-ant-api…); nothing was written');
  }
  return value;
}

/**
 * The credential `config.json` names after this run and whether that is a change, or a refusal when it names another
 * one and `--replace` is off.
 */
function nextCredential(
  config: RunnerConfig,
  kind: SetUpCredentialKind,
  replace: boolean,
): { credential: FileCredential; changed: boolean } {
  if (!CREDENTIAL_BACKENDS[kind].includes(config.backend)) {
    throw new CredentialSetupError(`a ${kind} credential is not allowed on the ${config.backend} backend`);
  }
  const wanted = { kind, file: CREDENTIAL_FILE_OF[kind] } as FileCredential;
  const current = config.credential;
  const same = current !== undefined && current.kind === kind && 'file' in current && current.file === wanted.file;
  if (current !== undefined && !same && !replace) {
    throw new CredentialSetupError(
      `config.json names a ${current.kind} credential; run again with --replace to switch this runner to ${kind}`,
    );
  }
  return { credential: wanted, changed: !same };
}

/** Sets up the credential and returns how many bytes were written; the value itself never leaves this function. */
export async function setUpCredential(deps: CredentialSetupDeps, options: CredentialSetupOptions): Promise<number> {
  const { credential, changed } = nextCredential(deps.config, options.kind, options.replace);
  const credentials = join(deps.home, CREDENTIALS_DIR);
  await ensurePrivateDir(credentials);
  const target = join(deps.home, credential.file);
  // Judged before the sign-in, so the operator never signs in for a token that would then be refused.
  if (!options.replace && (await lstatOrNull(target)) !== null) {
    throw new CredentialSetupError(
      `${credential.file} exists; run again with --replace to replace it (revoke the old one first, see the runbook)`,
    );
  }
  const value = options.kind === 'setup-token' ? await captureSetupToken(deps, options) : await readApiKey(deps);
  const content = `${value}\n`;
  await replacePrivateFile(target, content, { replace: options.replace });
  const bytes = Buffer.byteLength(content);
  if (changed) {
    await updateRunnerConfig(deps.home, (config) => ({ ...config, credential }));
  }
  deps.log(`credential: ${options.kind} written (${String(bytes)} bytes)`);
  return bytes;
}
