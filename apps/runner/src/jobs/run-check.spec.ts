import { chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { PassThrough } from 'node:stream';
import type { RunnerCheckClaimDto, RunnerIsolation } from '@shared/contracts';
import {
  CommandNotExecutableError,
  type CheckLaunchSpec,
  type ExitStatus,
  type IsolationBackend,
  type JobContext,
  type LaunchSpec,
  type RunningProcess,
  type Sandbox,
} from '../backends/backend';
import { NoneBackend } from '../backends/none';
import { createPrivateSandbox } from '../backends/sandbox';
import { RunnerApiError } from '../client/runner-client';
import type { CredentialConfig } from '../env/credential';
import { buildCheckEnv } from '../env/env-builder';
import { removeTree } from '../git/workspace';
import { CHECK_ID, sentinels } from '../testing/fake-console';
import { recordingConsole } from '../testing/job-fixture';
import {
  CHECK_COMMANDS,
  CHECK_STDOUT_MAX_BYTES,
  DECLARED_CHECKS,
  checkTimeoutMs,
  claudeVersionOf,
  runCheck,
  type CheckRunDeps,
} from './run-check';

/**
 * The runner check (#1059; security note "Tests required before merge → PR 2", items 1, 2, 3, 5 and 6) against a fake
 * backend and a real temp home, and a few runs through the real `none` backend. The fs spy records every path the
 * runner opens or lists, so a `claude-config-dir` is shown to be judged by `lstat` alone.
 */

const opened: string[] = [];
vi.mock('node:fs/promises', async (importOriginal) => {
  const real = await importOriginal<typeof import('node:fs/promises')>();
  const record =
    <A extends unknown[], R>(fn: (path: never, ...rest: A) => R) =>
    (path: unknown, ...rest: A): R => {
      opened.push(String(path));
      return fn(path as never, ...rest);
    };
  return {
    ...real,
    open: record(real.open),
    readFile: record(real.readFile),
    readdir: record(real.readdir),
    opendir: record(real.opendir),
  };
});

const CHECK: RunnerCheckClaimDto = { id: CHECK_ID, kind: 'smoke', deadlineSeconds: 30 };
const TOOLCHAIN = { path: '/opt/tc/bin:/usr/bin:/bin', claude: '/opt/tc/bin/claude' };

interface Plan {
  readonly stdout?: string | Buffer;
  readonly exit?: ExitStatus;
  /** Never exits until `kill`. */
  readonly hang?: boolean;
  readonly launchError?: Error;
  readonly preflightError?: Error;
  readonly prepareError?: Error;
  readonly cleanupError?: Error;
}

interface FakeBackend extends IsolationBackend {
  readonly calls: string[];
  readonly contexts: JobContext[];
  readonly specs: CheckLaunchSpec[];
  readonly streams: PassThrough[];
}

function fakeBackend(kind: RunnerIsolation, home: string, plan: Plan = {}): FakeBackend {
  const calls: string[] = [];
  const contexts: JobContext[] = [];
  const specs: CheckLaunchSpec[] = [];
  const streams: PassThrough[] = [];
  let exit: (status: ExitStatus) => void = () => undefined;
  return {
    kind,
    calls,
    contexts,
    specs,
    streams,
    preflight: async () => {
      calls.push('preflight');
      if (plan.preflightError !== undefined) {
        throw plan.preflightError;
      }
    },
    prepare: async (job: JobContext): Promise<Sandbox> => {
      calls.push('prepare');
      contexts.push(job);
      if (plan.prepareError !== undefined) {
        throw plan.prepareError;
      }
      return await createPrivateSandbox(home, job);
    },
    launch: async (_sandbox: Sandbox, _spec: LaunchSpec) => {
      throw new Error('a check never launches a job');
    },
    launchCheck: async (_sandbox: Sandbox, spec: CheckLaunchSpec): Promise<RunningProcess> => {
      calls.push('launchCheck');
      specs.push(spec);
      if (plan.launchError !== undefined) {
        throw plan.launchError;
      }
      const stdout = new PassThrough();
      streams.push(stdout);
      const exited = new Promise<ExitStatus>((resolve) => {
        exit = resolve;
      });
      if (!plan.hang) {
        setImmediate(() => {
          if (plan.stdout !== undefined) {
            stdout.write(plan.stdout);
          }
          stdout.end();
          exit(plan.exit ?? { exitCode: 0, signal: null });
        });
      }
      return { pid: 4242, stdout, exited };
    },
    kill: async () => {
      calls.push('kill');
      exit({ exitCode: null, signal: 'SIGKILL' });
    },
    cleanup: async (sandbox: Sandbox) => {
      calls.push('cleanup');
      await removeTree(sandbox.root);
      if (plan.cleanupError !== undefined) {
        throw plan.cleanupError;
      }
    },
  };
}

describe('the runner check table (S2)', () => {
  it('declares exactly the kinds it can run, each with its fixed argv and 30 s', () => {
    expect(DECLARED_CHECKS).toEqual(['smoke']);
    expect(CHECK_COMMANDS.smoke.argv).toEqual(['--version']);
    expect(CHECK_COMMANDS.smoke.command(TOOLCHAIN)).toBe(TOOLCHAIN.claude);
    expect(CHECK_COMMANDS.smoke.command({ path: '/usr/bin' })).toBeUndefined();
    expect(CHECK_COMMANDS.smoke.timeoutMs).toBe(30_000);
  });

  it('takes min(local, deadlineSeconds): the console can shorten the limit, never lengthen it', () => {
    expect(checkTimeoutMs('smoke', 30)).toBe(30_000);
    expect(checkTimeoutMs('smoke', 5)).toBe(5_000);
    expect(checkTimeoutMs('smoke', 3600)).toBe(30_000);
    expect(checkTimeoutMs('smoke', 0)).toBe(30_000);
    expect(checkTimeoutMs('smoke', Number.NaN)).toBe(30_000);
  });

  it('keeps only the first version match of the shared pattern (S6)', () => {
    expect(claudeVersionOf('2.1.3 (Claude Code)\n')).toBe('2.1.3');
    expect(claudeVersionOf('2.1.3 <img src=x onerror=alert(1)>')).toBe('2.1.3');
    expect(claudeVersionOf('2.1.3-beta.1 (Claude Code)')).toBe('2.1.3-beta.1');
    expect(claudeVersionOf('Claude Code 2.0.14\nand 3.0.0')).toBe('2.0.14');
    expect(claudeVersionOf('v22.12.0')).toBe('22.12.0');
    expect(claudeVersionOf('no version here')).toBeNull();
    expect(claudeVersionOf('1.2')).toBeNull();
    expect(claudeVersionOf('')).toBeNull();
  });

  it('builds the check env from nothing: exactly the five S6 keys', () => {
    expect(buildCheckEnv({ path: '/p', home: '/h', tmp: '/t' })).toEqual({
      PATH: '/p',
      HOME: '/h',
      TMPDIR: '/t',
      DISABLE_AUTOUPDATER: '1',
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
    });
  });

  it('keeps readOnly required on a job launch and absent on a check launch (S3, type level)', () => {
    const check: CheckLaunchSpec = { command: 'c', argv: [], env: {}, cwd: '/' };
    // @ts-expect-error a job launch cannot omit its plugin and managed settings
    const job: LaunchSpec = { command: 'c', argv: [], env: {}, cwd: '/', maxMinutes: 1 };
    // @ts-expect-error a check launch carries no read-only mounts
    const mounted: CheckLaunchSpec = { ...check, readOnly: { plugin: '/p', managedSettings: '/s' } };
    expect([check, job, mounted]).toHaveLength(3);
  });
});

describe('runCheck', () => {
  let home: string;
  let logs: string[];
  let client: ReturnType<typeof recordingConsole>;
  let armed: number[];

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'r-'));
    await mkdir(join(home, 'credentials'), { mode: 0o700 });
    logs = [];
    client = recordingConsole();
    armed = [];
    opened.length = 0;
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await rm(home, { recursive: true, force: true });
  });

  async function writeCredential(file: string, value: string, mode = 0o600): Promise<void> {
    await writeFile(join(home, file), `${value}\n`, { mode });
    await chmod(join(home, file), mode);
  }

  const apiKey: CredentialConfig = { kind: 'api-key', file: 'credentials/anthropic.key' };

  function depsFor(
    backend: IsolationBackend,
    config: Partial<CheckRunDeps['config']> = {},
    overrides: Partial<CheckRunDeps> = {},
  ): CheckRunDeps {
    let tick = 0;
    return {
      home,
      config: { backend: backend.kind === 'user' ? 'user' : 'none', credential: apiKey, toolchain: TOOLCHAIN, ...config },
      client,
      backend,
      log: (line) => logs.push(line),
      shutdown: new AbortController().signal,
      // 0 at the start, 840 at the end.
      clock: () => (tick++ === 0 ? 0 : 840),
      armTimeout: (_fire, ms) => {
        armed.push(ms);
        return () => undefined;
      },
      ...overrides,
    };
  }

  /** Arms the time limit and fires it at once, as a hang that reached it. */
  const firing: CheckRunDeps['armTimeout'] = (fire, ms) => {
    armed.push(ms);
    setImmediate(fire);
    return () => undefined;
  };

  it('passes: the exact launch, prepare with no project, cleanup, the finish body and the log line', async () => {
    await writeCredential('credentials/anthropic.key', sentinels.anthropicKey);
    const backend = fakeBackend('none', home, { stdout: '2.1.3 (Claude Code)\n' });
    const report = await runCheck(CHECK, depsFor(backend));

    expect(report).toEqual({ result: 'passed', reason: null, claudeVersion: '2.1.3', durationMs: 840 });
    expect(backend.calls).toEqual(['preflight', 'prepare', 'launchCheck', 'cleanup']);
    expect(backend.contexts).toEqual([{ jobId: CHECK_ID, projectSlug: null }]);
    const sandboxHome = join(home, 'jobs', CHECK_ID, 'home');
    expect(backend.specs).toEqual([
      {
        command: TOOLCHAIN.claude,
        argv: ['--version'],
        env: {
          PATH: TOOLCHAIN.path,
          HOME: sandboxHome,
          TMPDIR: join(home, 'jobs', CHECK_ID, 'tmp'),
          DISABLE_AUTOUPDATER: '1',
          CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
        },
        cwd: sandboxHome,
      },
    ]);
    expect(Object.keys(backend.specs[0] ?? {}).sort()).toEqual(['argv', 'command', 'cwd', 'env']);
    expect(client.checksFinished).toEqual([
      { checkId: CHECK_ID, input: { result: 'passed', claudeVersion: '2.1.3', durationMs: 840 } },
    ]);
    expect(Object.keys(client.checksFinished[0]?.input ?? {}).sort()).toEqual([
      'claudeVersion',
      'durationMs',
      'result',
    ]);
    expect(logs).toContain(`check ${CHECK_ID} smoke: passed (claude 2.1.3, 840 ms)`);
    expect(armed).toEqual([30_000]);
  });

  describe('a sentinel credential of each kind never leaves the presence check (security test 3)', () => {
    it.each([
      ['api-key file', 'none', 'api-key'],
      ['setup-token file', 'user', 'setup-token'],
    ] as const)('%s: not in the child env, the launch spec, a log line or the finish body', async (_what, kind, credKind) => {
      const value = credKind === 'api-key' ? sentinels.anthropicKey : sentinels.subscriptionToken;
      const file = credKind === 'api-key' ? 'credentials/anthropic.key' : 'credentials/claude-setup-token';
      await writeCredential(file, value);
      const backend = fakeBackend(kind, home, { stdout: '2.1.3\n' });
      const report = await runCheck(
        CHECK,
        depsFor(backend, { backend: kind === 'user' ? 'user' : 'none', credential: { kind: credKind, file } }),
      );

      expect(report?.result).toBe('passed');
      // The file was read (presence and shape), and its value went nowhere.
      expect(opened).toContain(join(home, file));
      const everything = JSON.stringify({ specs: backend.specs, logs, finished: client.checksFinished });
      expect(everything).not.toContain(value);
      expect(everything).not.toContain(value.slice(0, 16));
      expect(Object.values(backend.specs[0]?.env ?? {})).not.toContain(value);
      expect(Object.keys(backend.specs[0]?.env ?? {}).some((name) => /KEY|TOKEN|CLAUDE_CONFIG/.test(name))).toBe(
        false,
      );
    });

    it('claude-config-dir: lstat only, never a file inside opened, and the path goes nowhere', async () => {
      const configDir = join(home, `claude-config-${'Q'.repeat(24)}`);
      await mkdir(configDir, { mode: 0o700 });
      await writeFile(join(configDir, '.credentials.json'), sentinels.subscriptionToken, { mode: 0o600 });
      opened.length = 0;
      const backend = fakeBackend('container', home, { stdout: '2.1.3\n' });
      const report = await runCheck(
        CHECK,
        depsFor(backend, { backend: 'container', credential: { kind: 'claude-config-dir', path: configDir } }),
      );

      expect(report?.result).toBe('passed');
      expect(opened.filter((path) => path === configDir || path.startsWith(`${configDir}/`))).toEqual([]);
      const everything = JSON.stringify({ specs: backend.specs, logs, finished: client.checksFinished });
      expect(everything).not.toContain(configDir);
      expect(everything).not.toContain(sentinels.subscriptionToken);
    });
  });

  describe('credential reasons (security test 5)', () => {
    const reasonOf = async (
      credential: CredentialConfig | undefined,
      kind: RunnerIsolation = 'none',
    ): Promise<{ reason: string | null | undefined; calls: string[] }> => {
      const backend = fakeBackend(kind, home, { stdout: '2.1.3\n' });
      const report = await runCheck(
        CHECK,
        depsFor(backend, {
          backend: kind === 'container' ? 'container' : kind === 'user' ? 'user' : 'none',
          credential,
        }),
      );
      return { reason: report?.reason, calls: backend.calls };
    };

    it('no credential configured is credential-missing, and nothing is prepared or launched', async () => {
      expect(await reasonOf(undefined)).toEqual({ reason: 'credential-missing', calls: [] });
      expect(client.checksFinished).toEqual([
        { checkId: CHECK_ID, input: { result: 'failed', reason: 'credential-missing', durationMs: 840 } },
      ]);
    });

    it('a credential file that is not there is credential-missing', async () => {
      expect((await reasonOf(apiKey)).reason).toBe('credential-missing');
      await rm(join(home, 'credentials'), { recursive: true });
      expect((await reasonOf(apiKey)).reason).toBe('credential-missing');
    });

    it('0644, another owner, a symlink or a malformed value is credential-unreadable', async () => {
      await writeCredential('credentials/anthropic.key', sentinels.anthropicKey, 0o644);
      expect(await reasonOf(apiKey)).toEqual({ reason: 'credential-unreadable', calls: [] });

      await writeCredential('credentials/anthropic.key', sentinels.anthropicKey, 0o600);
      const uid = process.getuid?.() ?? 0;
      vi.spyOn(process, 'getuid').mockReturnValue(uid + 1);
      expect((await reasonOf(apiKey)).reason).toBe('credential-unreadable');
      vi.restoreAllMocks();

      await rm(join(home, 'credentials', 'anthropic.key'));
      await writeFile(join(home, 'real.key'), sentinels.anthropicKey, { mode: 0o600 });
      await symlink(join(home, 'real.key'), join(home, 'credentials', 'anthropic.key'));
      expect((await reasonOf(apiKey)).reason).toBe('credential-unreadable');

      await rm(join(home, 'credentials', 'anthropic.key'));
      await writeCredential('credentials/anthropic.key', 'short');
      expect((await reasonOf(apiKey)).reason).toBe('credential-unreadable');
      expect(JSON.stringify(logs)).not.toContain(sentinels.anthropicKey);
    });

    it('a kind on a backend it is not allowed on is credential-not-allowed', async () => {
      await writeCredential('credentials/claude-setup-token', sentinels.subscriptionToken);
      expect(
        (await reasonOf({ kind: 'setup-token', file: 'credentials/claude-setup-token' }, 'none')).reason,
      ).toBe('credential-not-allowed');
      expect((await reasonOf({ kind: 'claude-config-dir', path: home }, 'user')).reason).toBe(
        'credential-not-allowed',
      );
      expect((await reasonOf({ kind: 'api-key', env: 'TC_INFERENCE_API_KEY' }, 'none')).reason).toBe(
        'credential-not-allowed',
      );
      // An API key shaped like a subscription login is refused as a launch would.
      await writeCredential('credentials/anthropic.key', sentinels.subscriptionToken);
      expect((await reasonOf(apiKey)).reason).toBe('credential-not-allowed');
    });

    it('a claude-config-dir that is missing, a symlink, a file or group-writable is refused by lstat', async () => {
      const dir = join(home, 'claude');
      const config = { kind: 'claude-config-dir', path: dir } as const;
      expect((await reasonOf(config, 'container')).reason).toBe('credential-missing');
      await mkdir(join(home, 'elsewhere'), { mode: 0o700 });
      await symlink(join(home, 'elsewhere'), dir);
      expect((await reasonOf(config, 'container')).reason).toBe('credential-unreadable');
      await rm(dir);
      await writeFile(dir, 'x', { mode: 0o600 });
      expect((await reasonOf(config, 'container')).reason).toBe('credential-unreadable');
      await rm(dir);
      await mkdir(dir, { mode: 0o700 });
      await chmod(dir, 0o770);
      expect((await reasonOf(config, 'container')).reason).toBe('credential-unreadable');
      await chmod(dir, 0o700);
      expect((await reasonOf(config, 'container')).reason).toBeNull();
    });
  });

  describe('outcomes (security test 6)', () => {
    beforeEach(async () => {
      await writeCredential('credentials/anthropic.key', sentinels.anthropicKey);
    });

    it('no toolchain.claude is claude-not-configured, before anything is prepared', async () => {
      const backend = fakeBackend('none', home);
      const report = await runCheck(CHECK, depsFor(backend, { toolchain: { path: '/usr/bin' } }));
      expect(report?.reason).toBe('claude-not-configured');
      expect(backend.calls).toEqual([]);
    });

    it('a preflight or prepare refusal is host-not-ready, and nothing is launched', async () => {
      const refused = fakeBackend('none', home, { preflightError: new Error('a _tcjob process remains') });
      expect((await runCheck(CHECK, depsFor(refused)))?.reason).toBe('host-not-ready');
      expect(refused.calls).toEqual(['preflight']);
      const unprepared = fakeBackend('none', home, { prepareError: new Error('no sandbox') });
      expect((await runCheck(CHECK, depsFor(unprepared)))?.reason).toBe('host-not-ready');
      expect(unprepared.calls).toEqual(['preflight', 'prepare']);
    });

    it('ENOENT at spawn is claude-not-executable, and cleanup still runs', async () => {
      const backend = fakeBackend('none', home, {
        launchError: new CommandNotExecutableError('/opt/tc/bin/claude cannot be executed (ENOENT)'),
      });
      expect((await runCheck(CHECK, depsFor(backend)))?.reason).toBe('claude-not-executable');
      expect(backend.calls).toEqual(['preflight', 'prepare', 'launchCheck', 'cleanup']);
    });

    it('any other launch failure is host-not-ready, and cleanup still runs', async () => {
      const backend = fakeBackend('none', home, { launchError: new Error('sudo: a password is required') });
      expect((await runCheck(CHECK, depsFor(backend)))?.reason).toBe('host-not-ready');
      expect(backend.calls.at(-1)).toBe('cleanup');
    });

    it.each([126, 127])('exit %i is claude-not-executable', async (exitCode) => {
      const backend = fakeBackend('none', home, { exit: { exitCode, signal: null } });
      expect((await runCheck(CHECK, depsFor(backend)))?.reason).toBe('claude-not-executable');
    });

    it('another non-zero exit is claude-failed; the exit code stays in the local log', async () => {
      const backend = fakeBackend('none', home, { stdout: '2.1.3\n', exit: { exitCode: 3, signal: null } });
      const report = await runCheck(CHECK, depsFor(backend));
      expect(report?.reason).toBe('claude-failed');
      expect(client.checksFinished[0]?.input).toEqual({ result: 'failed', reason: 'claude-failed', durationMs: 840 });
      expect(logs).toContain(`check ${CHECK_ID} smoke: claude --version exited 3`);
      expect(logs).toContain(`check ${CHECK_ID} smoke: failed (claude-failed, 840 ms)`);
    });

    it('exit 0 without a version is claude-output-unrecognised', async () => {
      const backend = fakeBackend('none', home, { stdout: 'Usage: claude [options]\n' });
      expect((await runCheck(CHECK, depsFor(backend)))?.reason).toBe('claude-output-unrecognised');
    });

    it('reports the version alone: 2.1.3 <img> is 2.1.3', async () => {
      const backend = fakeBackend('none', home, { stdout: '2.1.3 <img src=x onerror=alert(1)>\n' });
      await runCheck(CHECK, depsFor(backend));
      expect(client.checksFinished[0]?.input).toEqual({ result: 'passed', claudeVersion: '2.1.3', durationMs: 840 });
      expect(JSON.stringify(logs)).not.toContain('<img');
    });

    it('reads at most 4 KiB of stdout and stops reading', async () => {
      const backend = fakeBackend('none', home, {
        stdout: Buffer.concat([Buffer.from('2.1.3 '), Buffer.alloc(5 * 1024 * 1024, 'x')]),
      });
      const report = await runCheck(CHECK, depsFor(backend));
      expect(report?.claudeVersion).toBe('2.1.3');
      expect(backend.streams[0]?.destroyed).toBe(true);
      expect(CHECK_STDOUT_MAX_BYTES).toBe(4096);
    });

    it('a hang is killed at 30 s and reported timeout; cleanup runs', async () => {
      const backend = fakeBackend('none', home, { hang: true });
      const report = await runCheck(CHECK, depsFor(backend, {}, { armTimeout: firing }));
      expect(report?.reason).toBe('timeout');
      expect(armed).toEqual([30_000]);
      expect(backend.calls).toEqual(['preflight', 'prepare', 'launchCheck', 'kill', 'cleanup']);
    });

    it('a shorter server deadline shortens the limit; a longer one is clamped to 30 s', async () => {
      await runCheck({ ...CHECK, deadlineSeconds: 5 }, depsFor(fakeBackend('none', home, { stdout: '2.1.3' })));
      await runCheck({ ...CHECK, deadlineSeconds: 3600 }, depsFor(fakeBackend('none', home, { stdout: '2.1.3' })));
      expect(armed).toEqual([5_000, 30_000]);
    });

    it('a shutdown kills the check and reports host-not-ready', async () => {
      const shutdown = new AbortController();
      const backend = fakeBackend('none', home, { hang: true });
      const running = runCheck(CHECK, depsFor(backend, {}, { shutdown: shutdown.signal }));
      await vi.waitFor(() => expect(backend.calls).toContain('launchCheck'));
      shutdown.abort();
      expect((await running)?.reason).toBe('host-not-ready');
      expect(backend.calls).toContain('kill');
    });

    it('a cleanup failure turns a pass into host-not-ready', async () => {
      const backend = fakeBackend('none', home, { stdout: '2.1.3', cleanupError: new Error('a _tcjob process survived') });
      const report = await runCheck(CHECK, depsFor(backend));
      expect(report?.reason).toBe('host-not-ready');
      expect(client.checksFinished[0]?.input).toEqual({ result: 'failed', reason: 'host-not-ready', durationMs: 840 });
    });

    it('clamps durationMs to 0–60000', async () => {
      const late = await runCheck(
        CHECK,
        depsFor(fakeBackend('none', home, { stdout: '2.1.3' }), {}, { clock: (() => {
          let tick = 0;
          return () => (tick++ === 0 ? 0 : 90_000);
        })() }),
      );
      expect(late?.durationMs).toBe(60_000);
      const skewed = await runCheck(
        CHECK,
        depsFor(fakeBackend('none', home, { stdout: '2.1.3' }), {}, { clock: (() => {
          let tick = 0;
          return () => (tick++ === 0 ? 100 : 0);
        })() }),
      );
      expect(skewed?.durationMs).toBe(0);
    });

    it('a finish 404 is logged once and not retried', async () => {
      const finishCheck = vi.fn(async () => {
        throw new RunnerApiError(404, 'runner-check-not-found', 'check finish: the console answered 404');
      });
      const backend = fakeBackend('none', home, { stdout: '2.1.3' });
      const report = await runCheck(CHECK, { ...depsFor(backend), client: { finishCheck } });
      expect(report?.result).toBe('passed');
      expect(finishCheck).toHaveBeenCalledTimes(1);
      expect(logs.filter((line) => line.includes('did not take the report'))).toHaveLength(1);
    });
  });

  describe('a malformed check launches nothing (security test 1)', () => {
    it.each([
      ['a path-shaped id', { ...CHECK, id: '../../x' }],
      ['a non-ULID id', { ...CHECK, id: 'x'.repeat(26) }],
      ['an unknown kind', { ...CHECK, kind: 'exec' as never }],
      ['a prototype kind', { ...CHECK, kind: 'constructor' as never }],
    ])('%s', async (_what, check) => {
      await writeCredential('credentials/anthropic.key', sentinels.anthropicKey);
      const backend = fakeBackend('none', home, { stdout: '2.1.3' });
      expect(await runCheck(check, depsFor(backend))).toBeNull();
      expect(backend.calls).toEqual([]);
      expect(client.checksFinished).toEqual([]);
      expect(logs).toEqual(['check: unexpected answer from the console; nothing was run']);
    });
  });

  describe('through the real none backend', () => {
    let bin: string;

    beforeEach(async () => {
      await writeCredential('credentials/anthropic.key', sentinels.anthropicKey);
      bin = await mkdtemp(join(tmpdir(), 'r-bin-'));
    });

    afterEach(async () => {
      await rm(bin, { recursive: true, force: true });
    });

    async function script(name: string, js: string): Promise<string> {
      const path = join(bin, name);
      // A node script with no shell in between: a shell would add PWD and SHLVL to what the child sees.
      await writeFile(path, `#!${process.execPath}\n${js}\n`, { mode: 0o755 });
      return path;
    }

    const realDeps = (claude: string, overrides: Partial<CheckRunDeps> = {}): CheckRunDeps => ({
      ...depsFor(new NoneBackend(home), { toolchain: { path: `${dirname(process.execPath)}:/usr/bin:/bin`, claude } }),
      clock: undefined,
      armTimeout: undefined,
      ...overrides,
    });

    it('runs with exactly the S6 env and the sandbox HOME as cwd; stderr is never read', async () => {
      const out = join(bin, 'seen.json');
      const claude = await script(
        'claude',
        `require("node:fs").writeFileSync(${JSON.stringify(out)}, JSON.stringify({ env: process.env, cwd: process.cwd() })); process.stderr.write(${JSON.stringify(sentinels.anthropicKey)}); console.log("2.1.3 (Claude Code)")`,
      );
      const report = await runCheck(CHECK, realDeps(claude));
      expect(report).toMatchObject({ result: 'passed', claudeVersion: '2.1.3' });
      const seen = JSON.parse(await readFile(out, 'utf8')) as { env: Record<string, string>; cwd: string };
      // macOS adds __CF_USER_TEXT_ENCODING to every process it starts.
      const keys = Object.keys(seen.env).filter((key) => key !== '__CF_USER_TEXT_ENCODING');
      expect(keys.sort()).toEqual([
        'CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC',
        'DISABLE_AUTOUPDATER',
        'HOME',
        'PATH',
        'TMPDIR',
      ]);
      expect(seen.cwd.endsWith(join('jobs', CHECK_ID, 'home'))).toBe(true);
      expect(JSON.stringify({ logs, finished: client.checksFinished })).not.toContain(sentinels.anthropicKey);
    });

    it('5 MiB of stdout is capped and does not hang', async () => {
      const claude = await script(
        'claude',
        'process.stdout.write("2.1.3 " + "x".repeat(5 * 1024 * 1024))',
      );
      const report = await runCheck(CHECK, realDeps(claude));
      expect(report?.reason).not.toBe('timeout');
      expect(report?.durationMs).toBeLessThan(15_000);
    });

    it('a missing command is claude-not-executable', async () => {
      const report = await runCheck(CHECK, realDeps(join(bin, 'nowhere', 'claude')));
      expect(report?.reason).toBe('claude-not-executable');
    });

    it('a hang is killed at the limit', async () => {
      const claude = await script('claude', 'setInterval(() => undefined, 1000)');
      const report = await runCheck(CHECK, realDeps(claude, { armTimeout: (fire) => {
        const id = setTimeout(fire, 300);
        return () => clearTimeout(id);
      } }));
      expect(report?.reason).toBe('timeout');
    });
  });
});
