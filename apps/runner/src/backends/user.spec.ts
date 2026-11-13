import { chmod, mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { GitError } from '../git/git';
import { SYSTEM_PATH, type Exec, type ExecOptions, type ExecResult, type Spawn } from '../host/exec';
import { JobRegistry } from '../proxy/job-registry';
import { startJobSocket } from '../proxy/socket-server';
import { JOB_ID } from '../testing/fake-console';
import { BackendError, type LaunchSpec, type RunningJob } from './backend';
import { UserBackend, managedSettingsText } from './user';

/**
 * Threat model C3 cross-job rows (c), (d), (e) and L3 through a fake exec (never the real sudo on a developer
 * machine): the exact `sudo -u _tcjob job-exec` / `pgrep` sequence of a job, the refusal while a `_tcjob` process
 * remains, the sweep notice, the root-owned managed settings, and the socket reachable by the job group only (#584).
 */

const JOB_EXEC = '/usr/local/lib/team-console-runner/bin/job-exec';
const NODE_DIR = '/opt/homebrew/bin';
const SUDO = (mode: string): string => `/usr/bin/sudo -n -u _tcjob -- ${JOB_EXEC} ${mode}`;

interface Call {
  readonly line: string;
  readonly stdin: string | undefined;
  readonly env: ExecOptions['env'];
}

describe('user backend', () => {
  let home: string;
  let settings: string;
  let calls: Call[];
  let answers: Map<string, ExecResult[]>;
  const gid = process.getgid?.() ?? 0;
  const uid = process.getuid?.() ?? 0;

  const answer = (line: string, ...results: ExecResult[]): void => {
    answers.set(line, results);
  };
  const exec: Exec = async (command, args, options) => {
    const line = [command, ...args].join(' ');
    calls.push({ line, stdin: options?.stdin, env: options?.env });
    const queued = answers.get(line);
    const next = queued !== undefined && queued.length > 1 ? queued.shift() : queued?.[0];
    return next ?? { code: 0, stdout: '' };
  };
  let exitJob: (status: { exitCode: number | null; signal: NodeJS.Signals | null }) => void;
  const spawn: Spawn = async (command, args, options) => {
    calls.push({ line: [command, ...args].join(' '), stdin: options.stdin, env: options.env });
    return {
      pid: 4242,
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      exited: new Promise((resolve) => {
        exitJob = resolve;
      }),
    };
  };
  const backend = (overrides: { rootUid?: number } = {}): UserBackend =>
    new UserBackend({
      home,
      jobExec: JOB_EXEC,
      nodeDir: NODE_DIR,
      managedSettingsPath: settings,
      exec,
      spawn,
      rootUid: overrides.rootUid ?? uid,
    });
  const spec = (sandbox: { home: string; tmp: string; clone: string }): LaunchSpec => ({
    command: 'claude',
    argv: ['-p', 'prompt'],
    env: { HOME: sandbox.home, TMPDIR: sandbox.tmp, TC_JOB_TOKEN: 'tcj_secret' },
    cwd: sandbox.clone,
    maxMinutes: 1,
    readOnly: { plugin: '/p', managedSettings: '/s' },
  });

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'r-'));
    await chmod(home, 0o750);
    settings = join(home, 'managed-settings.system.json');
    await writeFile(settings, managedSettingsText(), { mode: 0o644 });
    calls = [];
    answers = new Map();
    answer('/usr/bin/id -g _tcjob', { code: 0, stdout: `${String(gid)}\n` });
    answer('/usr/bin/pgrep -u _tcjob', { code: 1, stdout: '' });
  });

  afterEach(async () => {
    await rm(home, { recursive: true, force: true });
  });

  it('runs the exact sudo/pkill/pgrep/sweep sequence around a job', async () => {
    answer(
      SUDO('sweep'),
      { code: 0, stdout: '' },
      { code: 0, stdout: '/private/tmp/planted\n/Users/Shared/x\n' },
      {
        code: 0,
        stdout: '',
      },
    );
    const user = backend();
    await user.preflight();
    const sandbox = await user.prepare({ jobId: JOB_ID, projectSlug: 'team-console' });
    const running = await user.launch(sandbox, spec(sandbox));
    exitJob({ exitCode: 0, signal: null });
    await running.exited;
    const notices = await user.settle();
    await user.cleanup(sandbox);

    expect(calls.map((call) => call.line)).toEqual([
      '/usr/bin/id -g _tcjob',
      SUDO('reap'),
      '/usr/bin/pgrep -u _tcjob',
      SUDO('sweep'),
      SUDO('run'), // mkdir HOME and TMPDIR as _tcjob
      SUDO('run'), // the CLI
      SUDO('reap'),
      SUDO('sweep'),
      SUDO('reap'),
      SUDO('run'), // chmod the job's entries
      SUDO('run'), // rm them
      SUDO('sweep'),
      '/usr/bin/pgrep -u _tcjob',
    ]);
    // sudo finds node for job-exec on this PATH; nothing of the runner's env goes along.
    expect(calls.filter((call) => call.line.startsWith('/usr/bin/sudo')).map((call) => call.env)).toEqual(
      Array.from({ length: 10 }, () => ({ PATH: `${NODE_DIR}:${SYSTEM_PATH}` })),
    );
    expect(JSON.parse(calls[4]?.stdin ?? '')).toEqual({
      command: '/bin/mkdir',
      argv: ['-m', '700', sandbox.home, sandbox.tmp],
      env: { PATH: SYSTEM_PATH },
      cwd: sandbox.root,
    });
    // The job's env and token travel on stdin only, never in argv.
    expect(JSON.parse(calls[5]?.stdin ?? '')).toEqual({
      command: 'claude',
      argv: ['-p', 'prompt'],
      env: { HOME: sandbox.home, TMPDIR: sandbox.tmp, TC_JOB_TOKEN: 'tcj_secret' },
      cwd: sandbox.clone,
    });
    expect(calls.map((call) => call.line).join('\n')).not.toContain('tcj_secret');
    expect(JSON.parse(calls[9]?.stdin ?? '').argv).toEqual([
      sandbox.root,
      '-mindepth',
      '1',
      '-maxdepth',
      '1',
      '-user',
      '_tcjob',
      '-exec',
      '/bin/chmod',
      '-R',
      'u+rwX',
      '{}',
      '+',
    ]);
    expect(notices).toEqual([
      { sweep: 'removed', count: 2, paths: ['/private/tmp/planted', '/Users/Shared/x'] },
    ]);
    await expect(stat(sandbox.root)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('refuses to start a job while a _tcjob process remains after the pkill', async () => {
    answer('/usr/bin/pgrep -u _tcjob', { code: 0, stdout: '501\n502\n' });
    await expect(backend().preflight()).rejects.toThrow(/_tcjob process is still running \(pid 501, 502\)/);
    expect(calls.map((call) => call.line)).toEqual([
      '/usr/bin/id -g _tcjob',
      SUDO('reap'),
      '/usr/bin/pgrep -u _tcjob',
    ]);
  });

  it('fails cleanup when a _tcjob process survives it, so the next preflight refuses', async () => {
    const user = backend();
    const sandbox = await user.prepare({ jobId: JOB_ID, projectSlug: 'team-console' });
    answer('/usr/bin/pgrep -u _tcjob', { code: 0, stdout: '777\n' });
    await expect(user.cleanup(sandbox)).rejects.toThrow(/survived the job \(pid 777\)/);
  });

  it('refuses when sudo cannot run job-exec (no sudoers rule) or pgrep fails', async () => {
    answer(SUDO('reap'), { code: 2, stdout: '' });
    await expect(backend().preflight()).rejects.toThrow(/check the sudoers rule/);
    answer(SUDO('reap'), { code: 0, stdout: '' });
    answer('/usr/bin/pgrep -u _tcjob', { code: 3, stdout: '' });
    await expect(backend().preflight()).rejects.toThrow(/pgrep exited 3/);
  });

  it('refuses without a _tcjob user', async () => {
    answer('/usr/bin/id -g _tcjob', { code: 1, stdout: '' });
    await expect(backend().preflight()).rejects.toThrow(/no _tcjob user/);
  });

  describe('managed settings at the CLI managed path (decision 8, SECURITY on #589)', () => {
    it('refuses them missing', async () => {
      await rm(settings);
      await expect(backend().preflight()).rejects.toThrow(/is missing/);
    });

    it('refuses them when not root-owned', async () => {
      await expect(backend({ rootUid: uid + 1 }).preflight()).rejects.toThrow(/must be root-owned/);
    });

    it('refuses them writable by group or others', async () => {
      await chmod(settings, 0o664);
      await expect(backend().preflight()).rejects.toThrow(/must be root-owned and writable by root only/);
    });

    it('refuses other content (hooks re-enabled)', async () => {
      await writeFile(settings, '{"disableAllHooks": false}\n');
      await expect(backend().preflight()).rejects.toThrow(/not the runner’s managed settings/);
    });
  });

  it('refuses a home the job group cannot read', async () => {
    await chmod(home, 0o700);
    await expect(backend().preflight()).rejects.toThrow(/_tcrunner:_tcjob 0750/);
  });

  it('gives the job a sticky root and a socket only its group reaches (#584)', async () => {
    const sandbox = await backend().prepare({ jobId: JOB_ID, projectSlug: 'team-console' });
    const root = await stat(sandbox.root);
    expect(root.mode & 0o7777).toBe(0o1770);
    expect(root.gid).toBe(gid);
    const dir = await stat(sandbox.socketDir);
    expect(dir.mode & 0o777).toBe(0o750);
    expect(dir.gid).toBe(gid);
    expect(sandbox.socketMode).toBe(0o660);

    const socket = await startJobSocket({
      socketPath: join(sandbox.socketDir, 'tc.sock'),
      job: { id: JOB_ID, projectSlug: 'team-console' },
      registry: new JobRegistry(),
      forwarder: {
        forwardForProject: async () => ({ status: 200, headers: {}, body: Buffer.from('{}') }),
        forwardForRunnerJob: async () => ({ status: 200, headers: {}, body: Buffer.from('{}') }),
      },
      notice: async () => undefined,
      onError: () => undefined,
      socketMode: sandbox.socketMode,
    });
    try {
      const file = await stat(socket.path);
      expect(file.mode & 0o777).toBe(0o660);
      // Another local user is neither the owner nor in the job group: no bit of the path lets it through.
      for (const mode of [root.mode, dir.mode, file.mode]) {
        expect(mode & 0o007).toBe(0);
      }
    } finally {
      await socket.close();
    }
  });

  it('kills by pkill -9 -u _tcjob and waits for the job to end', async () => {
    const user = backend();
    const sandbox = await user.prepare({ jobId: JOB_ID, projectSlug: 'team-console' });
    const running: RunningJob = await user.launch(sandbox, spec(sandbox));
    const killed = user.kill(running);
    exitJob({ exitCode: null, signal: 'SIGKILL' });
    await killed;
    expect(calls.at(-1)?.line).toBe(SUDO('reap'));
  });

  it('runs the clone’s git as _tcjob with the spec on stdin, and fails on its exit code', async () => {
    const user = backend();
    answer(SUDO('run'), { code: 0, stdout: 'out' }, { code: 128, stdout: '' });
    await expect(user.jobGit(['clone', '--quiet', '/m', '/c'], { PATH: '/usr/bin' })).resolves.toBe('out');
    expect(JSON.parse(calls.at(-1)?.stdin ?? '')).toEqual({
      command: 'git',
      argv: ['clone', '--quiet', '/m', '/c'],
      env: { PATH: '/usr/bin' },
      cwd: '/',
    });
    await expect(user.jobGit(['clone', '/m', '/c'], { PATH: '/usr/bin' })).rejects.toBeInstanceOf(GitError);
  });

  it('wipes a sandbox a crash left behind before the next job, as _tcjob first', async () => {
    await mkdir(join(home, 'jobs', JOB_ID), { recursive: true });
    await backend().preflight();
    expect(calls.map((call) => call.line).slice(-2)).toEqual([SUDO('run'), SUDO('run')]);
    await expect(stat(join(home, 'jobs', JOB_ID))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('is a BackendError for the job loop to report', async () => {
    answer('/usr/bin/pgrep -u _tcjob', { code: 0, stdout: '1\n' });
    await expect(backend().preflight()).rejects.toBeInstanceOf(BackendError);
  });
});
