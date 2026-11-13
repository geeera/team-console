import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { ContainerBackend } from '../backends/container';
import { JobRegistry } from '../proxy/job-registry';
import { startJobSocket } from '../proxy/socket-server';
import { JOB_ID, jobFixture, sentinels } from '../testing/fake-console';
import { SCENARIO, makeRunnerHome, recordingConsole, runnerConfigFor } from '../testing/job-fixture';
import { runJob, type JobRunDeps } from '../jobs/run-job';

/**
 * Plant-then-verify on the `container` backend against a real Docker daemon (architect note on #468, decision 13;
 * #570): CI builds the runner image plus the fake CLI (`TC_RUNNER_TEST_IMAGE`, see ci.yml) and runs this file; it is
 * skipped where no image is given (a developer Mac with Docker off). The real job loop runs two jobs in containers:
 * the first plants a Claude hook, `.npmrc`, `.gitconfig`, a clone `core.hooksPath` and a detached process; the next
 * observes none of them. A third launch probes the mounts from inside.
 */

const IMAGE = process.env['TC_RUNNER_TEST_IMAGE'];
const FAKE_CLI_IN_IMAGE = '/opt/fixtures/claude-fake.mjs';
const IMAGE_PATH = '/usr/local/bin:/usr/bin:/bin';

describe.skipIf(IMAGE === undefined || IMAGE === '')('integration: container backend (Docker)', () => {
  let fixture: Awaited<ReturnType<typeof makeRunnerHome>>;
  let backend: ContainerBackend;
  const uid = process.getuid?.() ?? 0;
  const gid = process.getgid?.() ?? 0;

  beforeEach(async () => {
    fixture = await makeRunnerHome();
    backend = new ContainerBackend({
      home: fixture.home,
      settings: { image: IMAGE ?? '' },
      credential: undefined,
      runtimeEnv: { PATH: process.env['PATH'] ?? IMAGE_PATH, HOME: process.env['HOME'] ?? '/' },
      uid,
      gid,
    });
    await backend.preflight();
  });

  afterEach(async () => {
    await fixture.done();
  });

  function depsFor(client: ReturnType<typeof recordingConsole>): JobRunDeps {
    return {
      home: fixture.home,
      config: runnerConfigFor(fixture.repo, {
        backend: 'container',
        toolchain: { path: IMAGE_PATH, claude: FAKE_CLI_IN_IMAGE },
      }),
      client,
      backend,
      registry: new JobRegistry(),
      sourceEnv: { PATH: process.env['PATH'] },
      log: (line) => console.info(line),
      now: () => new Date(),
      shutdown: new AbortController().signal,
      limitStreak: 0,
      flushMs: 20,
    };
  }

  it('plant-then-verify: nothing a job plants reaches the next job', async () => {
    const plant = recordingConsole();
    await runJob(jobFixture({ items: [SCENARIO.plant] }), sentinels.jobToken, depsFor(plant));
    console.info(`[plant] ${JSON.stringify(plant.finished[0])}`);
    expect(plant.finished[0]).toMatchObject({ result: 'finished' });
    expect(String(plant.finished[0]?.summary)).toMatch(
      /^planted pid=\d+ settings-writable=false plugin-writable=false$/,
    );
    await backend.preflight();

    const verify = recordingConsole();
    await runJob(
      jobFixture({ id: '01JC00000000000000000000J3', items: [SCENARIO.verify] }),
      sentinels.jobToken,
      depsFor(verify),
    );
    console.info(`[verify] ${JSON.stringify(verify.finished[0])}`);
    expect(verify.finished[0]).toMatchObject({ result: 'finished', summary: 'clean' });
  }, 120_000);

  it('mounts: read-only root, no TC_RUNNER_HOME, the clone the only writable mount, the socket reachable', async () => {
    await writeFile(join(fixture.home, 'config.json'), '{}', { mode: 0o600 });
    await mkdir(join(fixture.home, 'keys'), { mode: 0o700 });
    const plugin = join(fixture.home, 'plugin', 'tree');
    await mkdir(plugin, { recursive: true });
    await writeFile(join(plugin, 'README.md'), 'plugin', { mode: 0o444 });
    const settings = join(fixture.home, 'managed-settings.json');
    await writeFile(settings, '{}', { mode: 0o444 });
    const sandbox = await backend.prepare({ jobId: JOB_ID, projectSlug: 'team-console' });
    await mkdir(sandbox.clone, { mode: 0o700 });
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
    });
    const probe = `
      const fs = require('node:fs'); const http = require('node:http');
      const writes = (p) => { try { fs.writeFileSync(p, 'x'); return true; } catch { return false; } };
      const managed = '/etc/claude-code/managed-settings.json';
      http.get({ socketPath: ${JSON.stringify(socket.path)}, path: '/api/v1/projects/team-console/items' }, (res) => {
        console.log(JSON.stringify({
          uid: process.getuid(),
          root: writes('/etc/planted'),
          home: writes(process.env.HOME + '/x'),
          tmp: writes('/tmp/x'),
          clone: writes(process.cwd() + '/x'),
          plugin: writes(${JSON.stringify(join(plugin, 'README.md'))}),
          settings: writes(${JSON.stringify(settings)}),
          managed: writes(managed),
          managedOwner: fs.statSync(managed).uid,
          runnerHome: fs.existsSync(${JSON.stringify(join(fixture.home, 'config.json'))}) || fs.existsSync(${JSON.stringify(join(fixture.home, 'keys'))}),
          socket: res.statusCode,
        }));
      }).on('error', (e) => console.log(JSON.stringify({ socketError: e.code })));`;
    try {
      const running = await backend.launch(sandbox, {
        command: 'node',
        argv: ['-e', probe],
        env: { PATH: IMAGE_PATH, HOME: sandbox.home, TMPDIR: sandbox.tmp },
        cwd: sandbox.clone,
        maxMinutes: 1,
        readOnly: { plugin, managedSettings: settings },
      });
      const lines: string[] = [];
      createInterface({ input: running.stdout }).on('line', (line) => lines.push(line));
      createInterface({ input: running.stderr }).on('line', (line) => console.info(`[stderr] ${line}`));
      expect(await running.exited).toMatchObject({ exitCode: 0 });
      await new Promise((resolve) => setTimeout(resolve, 100));
      console.info(`[mounts] ${lines.join('\n')}`);
      expect(JSON.parse(lines.at(-1) ?? '{}')).toEqual({
        uid,
        root: false,
        home: true,
        tmp: true,
        clone: true,
        plugin: false,
        settings: false,
        managed: false,
        managedOwner: 0,
        runnerHome: false,
        // No job token: the socket answers 401, which proves the container reached it.
        socket: 401,
      });
    } finally {
      await socket.close();
      await backend.cleanup(sandbox);
    }
  }, 120_000);
});
