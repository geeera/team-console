import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadRunnerConfig, saveRunnerConfig, type RunnerConfig } from '../config/config';
import { generateRunnerKey, saveRunnerKey } from '../config/runner-key';
import { hostExec } from '../host/exec';
import { ACCOUNT_ID, RUNNER_ID, fakeConsole, json, sentinels, type FakeAnswer } from '../testing/fake-console';
import { RUNNER_VERSION } from '../version';
import { EXIT_FAILED, EXIT_OK, EXIT_USAGE, runCli } from './cli';

/**
 * The CLI surface of #634 PR 2: `setup`'s flags, `self-check`, and the `_tcrunner` halves `setup` starts. The
 * network spy: with a credential planted in the home, nothing the runner sends names it, its kind or its length.
 */

const config: RunnerConfig = {
  schema: 1,
  apiUrl: 'http://127.0.0.1:22300',
  runnerId: RUNNER_ID,
  accountId: ACCOUNT_ID,
  name: 'Owner Mac',
  audience: 'team-console:local',
  projectScope: 'all',
  allowedProjects: [],
  pollSeconds: 60,
  backend: 'user',
  credential: { kind: 'setup-token', file: 'credentials/claude-setup-token' },
};

describe('setup, self-check and the runner halves (#634 PR 2)', () => {
  let parent: string;
  let home: string;
  let out: string[];
  let err: string[];

  beforeEach(async () => {
    parent = await mkdtemp(join(tmpdir(), 'tcr-setup-cli-'));
    home = join(parent, 'home');
    out = [];
    err = [];
  });

  afterEach(async () => {
    await rm(parent, { recursive: true, force: true });
  });

  async function run(argv: readonly string[], answer: FakeAnswer = () => json(500, {}), uid = 0) {
    const fake = fakeConsole(answer);
    const exit = await runCli(argv, {
      env: { TC_RUNNER_HOME: home },
      homeDir: parent,
      host: { os: 'darwin', arch: 'arm64', hostname: 'owner-mac' },
      fetch: fake.fetch,
      stdout: (line) => out.push(line),
      stderr: (line) => err.push(line),
      platform: 'darwin',
      uid,
      keys: { platform: 'linux', exec: hostExec, env: {} },
    });
    return { exit, requests: fake.requests };
  }

  it.each<[readonly string[], RegExp]>([
    [['setup', '--only', 'install,frobnicate'], /--only takes steps from/],
    [['setup', '--release', '/tmp/x.tgz'], /--release and --sha256 go together/],
    [['setup', '--credential', 'claude-config-dir'], /--credential must be setup-token or api-key/],
    [['setup', '--code', 'x'], /Unknown option '--code'/],
    [['setup-credential'], /needs --kind setup-token\|api-key/],
    [['setup-credential', '--kind', 'api-key', '--open-requests', 'relative'], /absolute path/],
    [['setup-toolchain', '--path', '/usr/bin'], /needs --path and --claude/],
    [['self-check', '--all'], /takes no arguments/],
  ])('refuses %j with usage', async (argv, message) => {
    expect((await run(argv)).exit).toBe(EXIT_USAGE);
    expect(err.join('\n')).toMatch(message);
  });

  it('stops setup with one line when it is not run as root', async () => {
    expect((await run(['setup', '--only', 'check'], undefined, 501)).exit).toBe(EXIT_FAILED);
    expect(err).toEqual(['setup stopped: setup creates _tcrunner and a LaunchDaemon: run it with sudo']);
  });

  it('refuses self-check without root', async () => {
    expect((await run(['self-check'], undefined, 501)).exit).toBe(EXIT_USAGE);
  });

  it('setup-toolchain writes the toolchain through updateRunnerConfig and refuses a bad one', async () => {
    await mkdir(home, { mode: 0o700 });
    await saveRunnerConfig(home, config);
    expect((await run(['setup-toolchain', '--path', '/opt/homebrew/bin:/usr/bin', '--claude', '/opt/homebrew/bin/claude'])).exit).toBe(EXIT_OK);
    await expect(loadRunnerConfig(home)).resolves.toMatchObject({
      toolchain: { path: '/opt/homebrew/bin:/usr/bin', claude: '/opt/homebrew/bin/claude' },
    });
    expect((await run(['setup-toolchain', '--path', 'relative', '--claude', 'claude'])).exit).toBe(EXIT_FAILED);
  });

  it('setup-credential refuses a setup-token before the toolchain is known', async () => {
    await mkdir(home, { mode: 0o700 });
    await saveRunnerConfig(home, config);
    expect((await run(['setup-credential', '--kind', 'setup-token'])).exit).toBe(EXIT_FAILED);
    expect(err.join('\n')).toContain('run setup --only toolchain first');
  });

  it('self-check --runner-half reports kind and file only, and its request carries no credential (network spy)', async () => {
    await mkdir(join(home, 'credentials'), { recursive: true, mode: 0o700 });
    await saveRunnerConfig(home, config);
    await saveRunnerKey(home, generateRunnerKey().privateKey, { platform: 'linux', exec: hostExec, env: {} });
    const planted = `${sentinels.subscriptionToken}\n`;
    await writeFile(join(home, 'credentials/claude-setup-token'), planted, { mode: 0o600 });

    const { exit, requests } = await run(['self-check', '--runner-half'], () =>
      json(200, {
        runner: {
          id: RUNNER_ID,
          name: 'Owner Mac',
          accountId: ACCOUNT_ID,
          projectScope: 'all',
          allowedProjects: [],
          isolation: 'user',
          version: RUNNER_VERSION,
          belowMinimum: false,
          pausedUntil: null,
          lastSeenAt: null,
        },
        projects: [{ slug: 'team-console', accessSource: 'subscription' }],
      }),
    );
    expect(exit).toBe(EXIT_OK);
    expect(JSON.parse(out.join(''))).toMatchObject({
      failure: null,
      config: { credential: { kind: 'setup-token', file: 'credentials/claude-setup-token' } },
      self: { projects: [{ slug: 'team-console', accessSource: 'subscription' }] },
    });
    expect(out.join('')).not.toContain(sentinels.subscriptionToken);
    expect(requests).toHaveLength(1);
    const [request] = requests;
    expect(request?.method).toBe('GET');
    const sent = `${request?.url ?? ''} ${JSON.stringify(request?.headers)} ${request?.body ?? ''}`;
    expect(sent).not.toContain(sentinels.subscriptionToken);
    expect(sent).not.toMatch(/setup-token|api-key|claude-config-dir/);
    // A GET with the JWT header only: no body to carry a length, and no header but the runner's own.
    expect(request?.body ?? null).toBeNull();
    expect(Object.keys(request?.headers ?? {}).filter((name) => name !== 'accept' && name !== 'authorization')).toEqual([]);
  });

  it('self-check --runner-half names the stage that failed', async () => {
    const { exit } = await run(['self-check', '--runner-half']);
    expect(exit).toBe(EXIT_OK);
    expect(JSON.parse(out.join(''))).toMatchObject({ failure: { stage: 'config' }, config: null });
  });
});
