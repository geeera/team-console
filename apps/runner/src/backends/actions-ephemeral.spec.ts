import { mkdtemp, readdir, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { removeTree } from '../git/workspace';
import type { Exec } from '../host/exec';
import { JOB_ID } from '../testing/fake-console';
import { ActionsEphemeralBackend } from './actions-ephemeral';

/** #669: `none`'s process model under the `actions-ephemeral` name, with the fresh per-job sandbox of every backend. */

describe('ActionsEphemeralBackend', () => {
  let home: string;
  const calls: string[] = [];
  const exec: Exec = async (command, args) => {
    calls.push([command, ...args].join(' '));
    return { code: 1, stdout: '' };
  };

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'tcr-ae-'));
    calls.length = 0;
  });

  afterEach(async () => {
    await removeTree(home);
  });

  it('names itself actions-ephemeral, the isolation the console gave the exchanged identity', () => {
    expect(new ActionsEphemeralBackend(home, exec).kind).toBe('actions-ephemeral');
  });

  it('makes a fresh 0700 HOME and TMPDIR per job and wipes the sandbox at cleanup', async () => {
    const backend = new ActionsEphemeralBackend(home, exec);
    await backend.preflight();
    const sandbox = await backend.prepare({ jobId: JOB_ID, projectSlug: 'team-console' });
    expect(sandbox.root).toBe(join(home, 'jobs', JOB_ID));
    for (const dir of [sandbox.home, sandbox.tmp]) {
      expect((await stat(dir)).mode & 0o777).toBe(0o700);
    }
    await expect(backend.prepare({ jobId: JOB_ID, projectSlug: 'team-console' })).rejects.toThrow(/already exists/);
    await backend.cleanup(sandbox);
    expect(await readdir(join(home, 'jobs'))).toEqual([]);
    // The sweep looks for a job process left in the sandbox, as `none` does.
    expect(calls.some((call) => call.startsWith('lsof '))).toBe(true);
  });

  it('runs the job with exactly the given env', async () => {
    const backend = new ActionsEphemeralBackend(home, exec);
    await backend.preflight();
    const sandbox = await backend.prepare({ jobId: JOB_ID, projectSlug: 'team-console' });
    const running = await backend.launch(sandbox, {
      command: process.execPath,
      argv: ['-e', 'process.stdout.write(JSON.stringify(Object.keys(process.env).sort()))'],
      env: { ONLY: '1' },
      cwd: sandbox.home,
      maxMinutes: 1,
      readOnly: { plugin: home, managedSettings: home },
    });
    const chunks: Buffer[] = [];
    running.stdout.on('data', (chunk: Buffer) => chunks.push(chunk));
    expect(await running.exited).toEqual({ exitCode: 0, signal: null });
    // macOS may add `__CF_USER_TEXT_ENCODING` for the process; nothing of the runner's env reaches it.
    const names = (JSON.parse(Buffer.concat(chunks).toString()) as string[]).filter((name) => !name.startsWith('__CF'));
    expect(names).toEqual(['ONLY']);
    await backend.cleanup(sandbox);
  });
});
