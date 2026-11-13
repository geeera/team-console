import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { Readable } from 'node:stream';
import { BackendError } from './backend';
import { jobExecSpecOf, parseJobExecSpec, resolveCommand, runJobExec } from './job-exec';

/** The job side of `user`/`container`: the launch spec on stdin, run with exactly its env, never as root. */

describe('job-exec run', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'je-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const stdin = (text: string): Readable => Readable.from([Buffer.from(text)]);

  it('round-trips a launch spec and refuses a malformed one', () => {
    const spec = { command: 'claude', argv: ['-p', 'x'], env: { HOME: '/h' }, cwd: '/c' };
    expect(parseJobExecSpec(jobExecSpecOf({ ...spec }))).toEqual(spec);
    for (const bad of [
      '',
      'null',
      '{"command":"x","argv":[],"env":{},"cwd":"relative"}',
      '{"command":"x","argv":[1],"env":{},"cwd":"/"}',
      '{"command":"x","argv":[],"env":{"A":1},"cwd":"/"}',
    ]) {
      expect(() => parseJobExecSpec(bad)).toThrow(BackendError);
    }
  });

  it('finds the command on the job’s PATH, not the caller’s', async () => {
    await expect(resolveCommand('node', dirname(process.execPath))).resolves.toBe(process.execPath);
    await expect(resolveCommand('node', dir)).rejects.toThrow(/not on the job's PATH/);
    await expect(resolveCommand('/bin/sh', undefined)).resolves.toBe('/bin/sh');
  });

  it('runs the spec with exactly its env and cwd and returns the exit code', async () => {
    const out = join(dir, 'env.json');
    const script = `require('node:fs').writeFileSync(${JSON.stringify(out)}, JSON.stringify({ env: process.env, cwd: process.cwd() })); process.exit(7)`;
    const code = await runJobExec(
      stdin(
        jobExecSpecOf({
          command: 'node',
          argv: ['-e', script],
          env: { PATH: dirname(process.execPath), ONLY: 'this' },
          cwd: dir,
        }),
      ),
      1000,
    );
    expect(code).toBe(7);
    const seen = JSON.parse(await readFile(out, 'utf8')) as {
      env: Record<string, string>;
      cwd: string;
    };
    delete seen.env['__CF_USER_TEXT_ENCODING'];
    expect(seen.env).toEqual({ PATH: dirname(process.execPath), ONLY: 'this' });
  });

  it('reports a signal as 128 + its number', async () => {
    const code = await runJobExec(
      stdin(
        jobExecSpecOf({
          command: process.execPath,
          argv: ['-e', "process.kill(process.pid, 'SIGKILL')"],
          env: {},
          cwd: dir,
        }),
      ),
      1000,
    );
    expect(code).toBe(137);
  });

  it('never runs a job as root', async () => {
    await expect(runJobExec(stdin('{}'), 0)).rejects.toThrow(/never runs a job as root/);
  });
});
