import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { JOB_ID, OTHER_JOB_ID } from '../testing/fake-console';
import type { LaunchSpec, RunningJob, Sandbox } from './backend';
import { BackendError } from './backend';
import { NoneBackend } from './none';

/** ADR 0008 decision 3: the `none` backend's sandbox, exact env, process-group kill and sweep. */

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

async function waitFor(check: () => boolean, ms = 5_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!check()) {
    if (Date.now() > deadline) {
      throw new Error('timed out');
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

async function output(running: RunningJob): Promise<string> {
  let text = '';
  running.stdout.setEncoding('utf8').on('data', (chunk: string) => {
    text += chunk;
  });
  await running.exited;
  await new Promise((resolve) => setTimeout(resolve, 50));
  return text;
}

describe('none backend', () => {
  let home: string;
  let backend: NoneBackend;

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'r-'));
    backend = new NoneBackend(home);
    await backend.preflight();
  });

  afterEach(async () => {
    await rm(home, { recursive: true, force: true });
  });

  const spec = (sandbox: Sandbox, script: string): LaunchSpec => ({
    command: process.execPath,
    argv: ['-e', script],
    env: { HOME: sandbox.home, TMPDIR: sandbox.tmp, ONLY: 'this' },
    cwd: sandbox.home,
    maxMinutes: 1,
    readOnly: { plugin: '/p', managedSettings: '/s' },
  });

  it('prepares a fresh, private sandbox per job and refuses to reuse one', async () => {
    const sandbox = await backend.prepare({ jobId: JOB_ID, projectSlug: 'team-console' });
    expect(sandbox.root).toBe(join(home, 'jobs', JOB_ID));
    for (const dir of [sandbox.root, sandbox.home, sandbox.tmp]) {
      expect((await stat(dir)).mode & 0o777).toBe(0o700);
    }
    expect(await readdir(sandbox.home)).toEqual([]);
    await expect(backend.prepare({ jobId: JOB_ID, projectSlug: 'team-console' })).rejects.toThrow(
      BackendError,
    );
    await expect(backend.prepare({ jobId: '../x', projectSlug: 'team-console' })).rejects.toThrow(
      BackendError,
    );
  });

  it('launches with exactly the given env', async () => {
    const sandbox = await backend.prepare({ jobId: JOB_ID, projectSlug: 'team-console' });
    const running = await backend.launch(sandbox, spec(sandbox, 'console.log(JSON.stringify(process.env))'));
    const env = JSON.parse(await output(running)) as Record<string, string>;
    // macOS adds __CF_USER_TEXT_ENCODING to every process; nothing of the runner's own env is there.
    delete env['__CF_USER_TEXT_ENCODING'];
    expect(env).toEqual({ HOME: sandbox.home, TMPDIR: sandbox.tmp, ONLY: 'this' });
  });

  it('kills the whole process group, a child that ignores SIGTERM included', async () => {
    const sandbox = await backend.prepare({ jobId: JOB_ID, projectSlug: 'team-console' });
    const running = await backend.launch(
      sandbox,
      spec(
        sandbox,
        `const c = require('node:child_process').spawn(process.execPath, ['-e', "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)"], { stdio: 'ignore' });
         console.log(c.pid); setInterval(() => {}, 1000);`,
      ),
    );
    let pid = 0;
    running.stdout.setEncoding('utf8').on('data', (chunk: string) => {
      pid = Number(chunk.trim());
    });
    await waitFor(() => pid > 0);
    await backend.kill(running);
    await waitFor(() => !alive(pid));
    expect(alive(running.pid)).toBe(false);
  });

  it('sweeps a detached process left in the sandbox, wipes the sandbox, and preflight then passes', async () => {
    const sandbox = await backend.prepare({ jobId: JOB_ID, projectSlug: 'team-console' });
    const detached = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
      cwd: sandbox.home,
      detached: true,
      stdio: 'ignore',
    });
    detached.unref();
    const pid = detached.pid ?? 0;
    await waitFor(() => alive(pid));
    await expect(backend.preflight()).rejects.toThrow(/still running/);

    await backend.cleanup(sandbox);
    await waitFor(() => !alive(pid));
    await expect(stat(sandbox.root)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(backend.preflight()).resolves.toBeUndefined();
  });

  it('wipes a sandbox a crash left behind before the next job', async () => {
    await mkdir(join(home, 'jobs', OTHER_JOB_ID, 'home'), { recursive: true });
    await backend.preflight();
    expect(await readdir(join(home, 'jobs'))).toEqual([]);
  });
});
