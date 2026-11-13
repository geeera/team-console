import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  ACCOUNT_ID,
  RUNNER_ID,
  fakeConsole,
  json,
  problem,
  sentinels,
  type FakeAnswer,
} from '../testing/fake-console';
import type { InstallHost } from '../install/install';
import { RUNNER_VERSION } from '../version';
import { EXIT_FAILED, EXIT_OK, EXIT_USAGE, runCli } from './cli';

describe('team-console-runner CLI', () => {
  let parent: string;
  let out: string[];
  let err: string[];

  beforeEach(async () => {
    parent = await mkdtemp(join(tmpdir(), 'tcr-cli-'));
    out = [];
    err = [];
  });

  afterEach(async () => {
    await rm(parent, { recursive: true, force: true });
  });

  function run(argv: readonly string[], answer: FakeAnswer = () => json(500, {})) {
    const fake = fakeConsole(answer);
    const exit = runCli(argv, {
      env: { TC_RUNNER_HOME: join(parent, 'home') },
      homeDir: parent,
      host: { os: 'linux', arch: 'x64', hostname: 'ci' },
      fetch: fake.fetch,
      stdout: (line) => out.push(line),
      stderr: (line) => err.push(line),
    });
    return { exit, requests: fake.requests };
  }

  const enrolArgs = [
    'enrol',
    '--url',
    'http://127.0.0.1:22300',
    '--code',
    sentinels.enrolmentCode,
    '--backend',
    'none',
  ];

  it('enrols and says where the config is, without printing the code', async () => {
    const { exit } = run(enrolArgs, () =>
      json(201, {
        runnerId: RUNNER_ID,
        accountId: ACCOUNT_ID,
        name: 'CI box',
        audience: 'team-console:local',
        allowedProjects: [],
        pollSeconds: 60,
      }),
    );

    expect(await exit).toBe(EXIT_OK);
    expect(out.join('\n')).toContain(`Enrolled "CI box" (${RUNNER_ID})`);
    expect(out.join('\n')).toContain('no projects yet');
    expect([...out, ...err].join('\n')).not.toContain(sentinels.enrolmentCode);
  });

  it.each([
    [401, 'enrolment-code-invalid', /wrong, already used or expired/],
    [422, 'runner-isolation-none', /choose --backend container or user/],
    [429, 'rate-limited', /wait a minute/],
    [403, 'account-suspended', /403 \(account-suspended\)/],
  ])('reports %i %s in words and exits 1', async (status, slug, message) => {
    const { exit } = run(enrolArgs, () => problem(status, slug));

    expect(await exit).toBe(EXIT_FAILED);
    expect(err.join('\n')).toMatch(message);
    expect(err.join('\n')).not.toContain(sentinels.enrolmentCode);
  });

  it('reports an unreachable console without its error text', async () => {
    const { exit } = run(enrolArgs, () => {
      throw new TypeError('fetch failed');
    });
    expect(await exit).toBe(EXIT_FAILED);
    expect(err.join('\n')).toContain('could not be reached');
  });

  it.each([
    [['enrol'], /needs --url, --code and --backend/],
    [['enrol', '--url', 'https://x.example', '--code', 'tce_x'], /needs --url, --code and --backend/],
    [['enrol', '--token', 'x'], /Unknown option/],
    [['enrol', 'positional'], /Unexpected argument|positional/i],
    [
      ['enrol', '--url', 'http://console.example', '--code', sentinels.enrolmentCode, '--backend', 'user'],
      /--url must be/,
    ],
    [['frobnicate'], /Unknown command "frobnicate"/],
  ])('exits 2 with usage for %j', async (argv, message) => {
    const { exit, requests } = run(argv);
    expect(await exit).toBe(EXIT_USAGE);
    expect(err.join('\n')).toMatch(message);
    expect(requests).toEqual([]);
  });

  it('prints its version', async () => {
    expect(await run(['version']).exit).toBe(EXIT_OK);
    expect(out).toEqual([RUNNER_VERSION]);
  });

  it('prints usage for help (0) and for no command (2)', async () => {
    expect(await run(['--help']).exit).toBe(EXIT_OK);
    expect(await run([]).exit).toBe(EXIT_USAGE);
    expect(out.join('\n')).toContain(
      'enrol --url <console origin> --code <tce_…> --backend container|user|none',
    );
  });

  it('refuses run without --loop and run-once with arguments', async () => {
    expect(await run(['run']).exit).toBe(EXIT_USAGE);
    expect(await run(['run', '--forever']).exit).toBe(EXIT_USAGE);
    expect(await run(['run-once', '--loop']).exit).toBe(EXIT_USAGE);
    expect(err.join('\n')).toContain('run needs --loop');
  });

  it('fails run-once on a home that was never enrolled, touching no network', async () => {
    const { exit, requests } = run(['run-once']);
    expect(await exit).toBe(EXIT_FAILED);
    expect(err.join('\n')).toMatch(/^run failed: /);
    expect(requests).toEqual([]);
  });

  it('refuses enrol with a credential the backend may not use, before any request (RR11)', async () => {
    const { exit, requests } = run([
      ...enrolArgs.slice(0, -2),
      '--backend',
      'container',
      '--credential',
      'setup-token',
    ]);
    expect(await exit).toBe(EXIT_USAGE);
    expect(err.join('\n')).toMatch(/--credential setup-token is not allowed with --backend container/);
    expect(requests).toEqual([]);
  });

  describe('install', () => {
    const fakeInstallHost = (): InstallHost & { applied: unknown[]; queried: string[] } => {
      const applied: unknown[] = [];
      const queried: string[] = [];
      return {
        platform: 'linux',
        uid: 1000,
        homeDir: '/home/me',
        exec: async (command, args) => {
          queried.push([command, ...args].join(' '));
          return { code: 0, stdout: '' };
        },
        stat: async () => null,
        read: async () => null,
        apply: async (step) => {
          applied.push(step);
        },
        applied,
        queried,
      };
    };
    const installRun = (argv: readonly string[], host: InstallHost) =>
      runCli(argv, {
        env: {},
        homeDir: '/home/me',
        host: { os: 'linux', arch: 'x64', hostname: 'ci' },
        fetch: fakeConsole(() => json(500, {})).fetch,
        stdout: (line) => out.push(line),
        stderr: (line) => err.push(line),
        prefix: '/opt/tcr',
        installHost: host,
      });
    const image = `ghcr.io/geeera/team-console-runner:0.1.0@sha256:${'c'.repeat(64)}`;

    it.each([
      [['install'], /exactly one of --dry-run or --yes/],
      [['install', '--backend', 'user'], /exactly one of --dry-run or --yes/],
      [['install', '--backend', 'user', '--dry-run', '--yes'], /exactly one of --dry-run or --yes/],
      [['install', '--backend', 'none', '--dry-run'], /--backend user\|container/],
      [['install', '--backend', 'container', '--dry-run', '--runtime', 'lxc'], /--runtime must be/],
      [['install', '--sudo'], /Unknown option/],
    ])('exits 2 with usage for %j', async (argv, message) => {
      const host = fakeInstallHost();
      expect(await installRun(argv, host)).toBe(EXIT_USAGE);
      expect(err.join('\n')).toMatch(message);
      expect(host.queried).toEqual([]);
    });

    it('--dry-run lists the steps and applies none', async () => {
      const host = fakeInstallHost();
      expect(
        await installRun(['install', '--backend', 'container', '--dry-run', '--image', image], host),
      ).toBe(EXIT_OK);
      expect(host.applied).toEqual([]);
      expect(out[0]).toMatch(/^Dry run, nothing changed\. With --yes these 4 steps run as you:$/);
      expect(out[1]).toBe(`  1. docker pull ${image}`);
    });

    it('--yes applies them; a refusal exits 1 with its reason', async () => {
      const host = fakeInstallHost();
      expect(await installRun(['install', '--backend', 'container', '--yes', '--image', image], host)).toBe(
        EXIT_OK,
      );
      expect(host.applied).toHaveLength(4);
      expect(await installRun(['install', '--backend', 'user', '--yes'], fakeInstallHost())).toBe(
        EXIT_FAILED,
      );
      expect(err.join('\n')).toMatch(/^install failed: .*run it with sudo/);
    });
  });
});
