import { mkdir, mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import type { ContainerSettings } from '../config/config';
import type { CredentialConfig } from '../env/credential';
import type { Exec, ExecResult, Spawn } from '../host/exec';
import { JOB_ID } from '../testing/fake-console';
import type { LaunchSpec, Sandbox } from './backend';
import { CONTAINER_JOB_EXEC, ContainerBackend, JOB_LABEL, containerNameOf } from './container';

/**
 * ADR 0008 decision 12 and threat model C3/L4 for the `container` backend: the exact `docker run` arguments — a
 * read-only root, HOME/TMPDIR on tmpfs, the clone the only writable mount, nothing of `TC_RUNNER_HOME` but the
 * job's own paths, the env on stdin — and the refusals of preflight. Plant-then-verify against a real Docker daemon is
 * `container.integration.spec.ts` (CI).
 */

const IMAGE = `ghcr.io/geeera/team-console-runner:0.0.0@sha256:${'a'.repeat(64)}`;
const RUNTIME_ENV = { PATH: '/usr/local/bin:/usr/bin:/bin', HOME: '/home/runner' };

describe('container backend', () => {
  let home: string;
  let calls: { line: string; stdin: string | undefined; env: unknown }[];
  let answers: Map<string, ExecResult[]>;

  const exec: Exec = async (command, args, options) => {
    const line = [command, ...args].join(' ');
    calls.push({ line, stdin: options?.stdin, env: options?.env });
    const queued = answers.get(line);
    return (
      (queued !== undefined && queued.length > 1 ? queued.shift() : queued?.[0]) ?? { code: 0, stdout: '' }
    );
  };
  const spawn: Spawn = async (command, args, options) => {
    calls.push({ line: [command, ...args].join(' '), stdin: options.stdin, env: options.env });
    return {
      pid: 99,
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      exited: Promise.resolve({ exitCode: 0, signal: null }),
    };
  };
  const backend = (
    overrides: { settings?: ContainerSettings | undefined; credential?: CredentialConfig; uid?: number } = {},
  ): ContainerBackend =>
    new ContainerBackend({
      home,
      settings: 'settings' in overrides ? overrides.settings : { image: IMAGE },
      credential: overrides.credential,
      runtimeEnv: RUNTIME_ENV,
      uid: overrides.uid ?? 1001,
      gid: 1001,
      exec,
      spawn,
    });
  const spec = (sandbox: Sandbox): LaunchSpec => ({
    command: 'claude',
    argv: ['-p', 'x'],
    env: { HOME: sandbox.home, TC_JOB_TOKEN: 'tcj_secret' },
    cwd: sandbox.clone,
    maxMinutes: 5,
    readOnly: { plugin: join(home, 'plugin', 'abc'), managedSettings: join(home, 'managed-settings.json') },
  });

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'r-'));
    calls = [];
    answers = new Map();
  });

  afterEach(async () => {
    await rm(home, { recursive: true, force: true });
  });

  it('runs one locked-down container per job with exactly these arguments', async () => {
    const sandbox = await backend().prepare({ jobId: JOB_ID, projectSlug: 'team-console' });
    const name = containerNameOf(JOB_ID);
    const tmpfs = 'rw,nosuid,nodev,mode=0700,uid=1001,gid=1001';
    expect(backend().runArgs(sandbox, spec(sandbox))).toEqual([
      'run',
      '--interactive',
      '--rm',
      '--name',
      name,
      '--label',
      `${JOB_LABEL}=${JOB_ID}`,
      '--user',
      '1001:1001',
      '--read-only',
      '--cap-drop',
      'ALL',
      '--security-opt',
      'no-new-privileges',
      '--network',
      'bridge',
      '--pids-limit',
      '512',
      '--memory',
      '4096m',
      '--tmpfs',
      '/tmp:rw,nosuid,nodev,mode=1777',
      '--tmpfs',
      `${sandbox.home}:${tmpfs}`,
      '--tmpfs',
      `${sandbox.tmp}:${tmpfs}`,
      '--mount',
      `type=bind,src=${sandbox.clone},dst=${sandbox.clone}`,
      '--mount',
      `type=bind,src=${sandbox.socketDir},dst=${sandbox.socketDir},readonly`,
      '--mount',
      `type=bind,src=${home}/plugin/abc,dst=${home}/plugin/abc,readonly`,
      '--mount',
      `type=bind,src=${home}/managed-settings.json,dst=${home}/managed-settings.json,readonly`,
      '--workdir',
      sandbox.clone,
      '--entrypoint',
      CONTAINER_JOB_EXEC,
      IMAGE,
      'run',
    ]);
  });

  it('mounts the clone as the only writable volume and never TC_RUNNER_HOME or its secrets', async () => {
    const user = backend({ credential: { kind: 'claude-config-dir', path: '/Users/me/.claude' } });
    const sandbox = await user.prepare({ jobId: JOB_ID, projectSlug: 'team-console' });
    const args = user.runArgs(sandbox, spec(sandbox));
    const mounts = args.filter((_, at) => args[at - 1] === '--mount');
    expect(mounts.filter((mount) => !mount.endsWith(',readonly'))).toEqual([
      `type=bind,src=${sandbox.clone},dst=${sandbox.clone}`,
    ]);
    const sources = mounts.map((mount) => /src=([^,]+)/.exec(mount)?.[1] ?? '');
    for (const secret of [
      home,
      join(home, 'config.json'),
      join(home, 'keys'),
      join(home, 'credentials'),
      join(home, 'work'),
    ]) {
      expect(sources.some((source) => secret === source || secret.startsWith(`${source}/`))).toBe(false);
    }
    expect(args).toContain('--read-only');
    expect(args).not.toContain('--privileged');
    expect(mounts).toContain('type=bind,src=/Users/me/.claude,dst=/home/job/.claude,readonly');
    expect(args.filter((arg) => arg === '-e' || arg === '--env' || arg.startsWith('--env'))).toEqual([]);
  });

  it('sends the env on stdin, never in argv, and kills and removes the container', async () => {
    const user = backend();
    const sandbox = await user.prepare({ jobId: JOB_ID, projectSlug: 'team-console' });
    const running = await user.launch(sandbox, spec(sandbox));
    await user.kill(running);
    answers.set(`docker ps -aq --filter label=${JOB_LABEL}=${JOB_ID}`, [
      { code: 0, stdout: 'abcdef123456\n' },
      { code: 0, stdout: '' },
    ]);
    await user.cleanup(sandbox);
    const name = containerNameOf(JOB_ID);
    expect(calls.map((call) => call.line.split(' ').slice(0, 2).join(' '))).toEqual([
      'docker run',
      `docker kill`,
      'docker ps',
      'docker rm',
      'docker ps',
    ]);
    expect(calls[1]?.line).toBe(`docker kill ${name}`);
    expect(calls[3]?.line).toBe('docker rm -f abcdef123456');
    expect(calls[0]?.line).not.toContain('tcj_secret');
    expect(JSON.parse(calls[0]?.stdin ?? '').env).toEqual({ HOME: sandbox.home, TC_JOB_TOKEN: 'tcj_secret' });
    expect(calls.every((call) => call.env === RUNTIME_ENV)).toBe(true);
    await expect(stat(sandbox.root)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('removes a crashed job’s leftover container and sandbox in preflight', async () => {
    await mkdir(join(home, 'jobs', JOB_ID), { recursive: true });
    answers.set(`docker ps -aq --filter label=${JOB_LABEL}`, [
      { code: 0, stdout: 'abcdef123456\n' },
      { code: 0, stdout: '' },
    ]);
    await backend().preflight();
    expect(calls.map((call) => call.line)).toEqual([
      'docker version',
      `docker ps -aq --filter label=${JOB_LABEL}`,
      'docker rm -f abcdef123456',
      `docker ps -aq --filter label=${JOB_LABEL}`,
    ]);
    await expect(stat(join(home, 'jobs', JOB_ID))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  describe('refuses', () => {
    it('without an image pinned by digest', async () => {
      await expect(backend({ settings: undefined }).preflight()).rejects.toThrow(/container.image/);
    });

    it('to run a job as root', async () => {
      await expect(backend({ uid: 0 }).preflight()).rejects.toThrow(/never runs a job as root/);
    });

    it('when the runtime is not running', async () => {
      answers.set('docker version', [{ code: 1, stdout: '' }]);
      await expect(backend().preflight()).rejects.toThrow(/daemon is not running/);
    });

    it('while a previous job’s container cannot be removed', async () => {
      answers.set(`docker ps -aq --filter label=${JOB_LABEL}`, [{ code: 0, stdout: 'abcdef123456\n' }]);
      answers.set('docker rm -f abcdef123456', [{ code: 1, stdout: '' }]);
      await expect(backend().preflight()).rejects.toThrow(/could not be removed/);
    });

    it('a mount path with a comma', async () => {
      const sandbox = await backend().prepare({ jobId: JOB_ID, projectSlug: 'team-console' });
      const bad = { ...spec(sandbox), readOnly: { plugin: '/a,dst=/etc', managedSettings: '/s' } };
      expect(() => backend().runArgs(sandbox, bad)).toThrow(/no comma/);
    });

    it('cleanup when the container survives rm', async () => {
      const sandbox = await backend().prepare({ jobId: JOB_ID, projectSlug: 'team-console' });
      answers.set(`docker ps -aq --filter label=${JOB_LABEL}=${JOB_ID}`, [
        { code: 0, stdout: 'abcdef123456\n' },
      ]);
      await expect(backend().cleanup(sandbox)).rejects.toThrow(/could not be removed/);
    });
  });
});
