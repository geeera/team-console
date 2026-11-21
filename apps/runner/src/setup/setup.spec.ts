import { createHash } from 'node:crypto';
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runnerKeyFingerprintOf, type Ed25519PublicJwk } from '@shared/contracts';
import { managedSettingsText } from '../backends/user';
import { runCli, type CliDeps } from '../cli/cli';
import { loadRunnerConfig } from '../config/config';
import { hostExec, type Exec } from '../host/exec';
import type { PathFacts } from '../install/install';
import { DOCUMENTED_DEFAULTS, launchDaemonPlist, sudoersRule } from '../install/templates';
import { ACCOUNT_ID, RUNNER_ID, json, problem } from '../testing/fake-console';
import { RUNNER_VERSION } from '../version';
import { hostSpawnClaude, type SpawnClaude } from './credential';
import { openRequestChannel } from './host';
import type { SetupHost } from './self-check';
import { SetupError, installRelease, runSetup, type SetupOptions } from './setup';

/**
 * `setup` end to end on a fake Mac (#634 PR 2): root's half against a table of system paths and command answers, the
 * runner's half as the real CLI in this process against a temporary home, and a stand-in `claude` that prints a
 * sign-in URL and a token. What root prints, what the terminal shows and what the console receives are kept apart,
 * so the spec can say where the token went: into the credential file, and nowhere else.
 */

const HOME = DOCUMENTED_DEFAULTS.home;
const PREFIX = DOCUMENTED_DEFAULTS.prefix;
const NODE = '/usr/local/bin/node';
const CLAUDE = '/opt/homebrew/bin/claude';
const INTENT = '01JC00000000000000000000Q1';
const API = 'http://127.0.0.1:22300';
const TOKEN = `sk-ant-oat01-${'Vb8_-'.repeat(20)}tail`;
const SIGN_IN = 'https://claude.ai/oauth/authorize?code=true&client=setup';
const OWN_UID = process.getuid?.() ?? 501;

const dir = (uid = 0, mode = 0o755): PathFacts => ({ uid, mode, kind: 'directory' });
const file = (uid = 0, mode = 0o555): PathFacts => ({ uid, mode, kind: 'file' });

interface World {
  readonly host: SetupHost;
  readonly rootOut: string[];
  terminal: string;
  readonly execs: string[];
  readonly requests: { url: string; body: string }[];
  readonly opened: string[];
  claudeRuns: number;
  sudoRules: string;
}

describe('setup (#634 PR 2)', () => {
  let root: string;
  let home: string;
  let tmpRoot: string;
  let fakeClaude: string;

  beforeEach(async () => {
    root = await realpath(await mkdtemp(join(tmpdir(), 'tcr-setup-')));
    home = join(root, 'home');
    tmpRoot = join(root, 'tmp');
    await mkdir(home, { mode: 0o710 });
    await chmod(home, 0o710);
    await mkdir(tmpRoot, { mode: 0o700 });
    for (const name of ['credentials', 'logs']) {
      await mkdir(join(home, name), { mode: 0o700 });
    }
    fakeClaude = join(root, 'claude');
    await writeFile(
      fakeClaude,
      [
        '#!/bin/sh',
        'echo "Browser didn\'t open? Use the url below to sign in:"',
        `echo "${SIGN_IN}"`,
        'printf "Paste code here if prompted > "',
        `printf '\\nYour OAuth token:\\n${TOKEN}\\nStore this token securely.\\n'`,
        '',
      ].join('\n'),
    );
    await chmod(fakeClaude, 0o755);
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  function world(): World {
    const rootOut: string[] = [];
    const execs: string[] = [];
    const requests: { url: string; body: string }[] = [];
    const opened: string[] = [];
    let loaded = false;
    const state: World = {
      host: undefined as unknown as SetupHost,
      rootOut,
      terminal: '',
      execs,
      requests,
      opened,
      claudeRuns: 0,
      sudoRules: `    (_tcjob) NOPASSWD: ${PREFIX}/bin/job-exec\n`,
    };

    // The console: an intent the owner approves on the second poll, and /runner/self.
    let polls = 0;
    const fetch: CliDeps['fetch'] = async (url, init) => {
      const body = typeof init.body === 'string' ? init.body : '';
      requests.push({ url, body });
      if (url.endsWith('/enrol/start')) {
        const { publicKey } = JSON.parse(body) as { publicKey: Ed25519PublicJwk };
        return json(200, {
          pollToken: `tcep_${'P'.repeat(43)}`,
          fingerprint: await runnerKeyFingerprintOf(publicKey),
          intervalSeconds: 5,
          expiresAt: new Date(Date.now() + 600_000).toISOString(),
          accountName: 'Geeera',
        });
      }
      if (url.endsWith('/enrol/poll')) {
        polls += 1;
        return polls < 2
          ? json(202, { state: 'bound', intervalSeconds: 5 })
          : json(200, {
              runnerId: RUNNER_ID,
              accountId: ACCOUNT_ID,
              name: 'Owner Mac',
              audience: 'team-console:local',
              projectScope: 'all',
              allowedProjects: [],
              pollSeconds: 60,
            });
      }
      if (url.endsWith('/runner/self')) {
        return json(200, {
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
            lastSeenAt: new Date().toISOString(),
          },
          projects: [{ slug: 'team-console', accessSource: 'subscription' }],
        });
      }
      return problem(404, 'not-found');
    };

    // `claude` as the toolchain found it is the stand-in on this machine.
    const spawnClaude: SpawnClaude = (command, args, env, cwd) => {
      state.claudeRuns += 1;
      return hostSpawnClaude(command, args.map((arg) => (arg === CLAUDE ? fakeClaude : arg)), env, cwd);
    };
    const childDeps = (stdout: (line: string) => void): CliDeps => ({
      env: { TC_RUNNER_HOME: home, TERM: 'xterm-256color' },
      homeDir: home,
      host: { os: 'darwin', arch: 'arm64', hostname: 'owner-mac.local' },
      fetch,
      stdout,
      stderr: (line) => (state.terminal += `${line}\n`),
      terminal: { stdout: (text) => (state.terminal += text), stderr: (text) => (state.terminal += text) },
      keys: { platform: 'linux', exec: hostExec, env: {} },
      sleep: () => Promise.resolve(),
      spawnClaude,
      tmpRoot,
    });

    const mapped = (path: string): string | null =>
      path === HOME ? home : path.startsWith(`${HOME}/`) ? join(home, path.slice(HOME.length + 1)) : null;
    const plist = launchDaemonPlist({ node: NODE, prefix: PREFIX, home: HOME });
    const files: Record<string, string> = {
      '/Library/Application Support/ClaudeCode/managed-settings.json': managedSettingsText(),
      '/etc/sudoers.d/team-console-runner': sudoersRule(PREFIX),
      '/Library/LaunchDaemons/com.team-console.runner.plist': plist,
    };
    const stats: Record<string, PathFacts> = {
      '/': dir(),
      '/usr': dir(),
      '/usr/bin': dir(),
      '/usr/bin/git': file(),
      '/usr/local': dir(),
      '/usr/local/bin': dir(),
      [NODE]: file(),
      '/usr/local/lib': dir(),
      [PREFIX]: dir(),
      [`${PREFIX}/bin`]: dir(),
      [`${PREFIX}/team-console-runner.mjs`]: file(),
      [`${PREFIX}/bin/job-exec`]: file(),
      '/opt': dir(),
      '/opt/homebrew': dir(OWN_UID),
      '/opt/homebrew/bin': dir(OWN_UID),
      [CLAUDE]: file(OWN_UID),
      '/Users': dir(),
      '/Library': dir(),
      '/Library/LaunchDaemons': dir(),
      '/Library/LaunchDaemons/com.team-console.runner.plist': file(0, 0o644),
      '/Library/Application Support': dir(),
      '/Library/Application Support/ClaudeCode': dir(),
      '/Library/Application Support/ClaudeCode/managed-settings.json': file(0, 0o644),
      '/etc/sudoers.d/team-console-runner': file(0, 0o440),
    };
    const exec: Exec = async (command, args, options) => {
      const line = [command, ...args].join(' ');
      execs.push(line);
      if (command === '/usr/bin/id' && args[1] === '_tcrunner') {
        return { code: 0, stdout: `${String(OWN_UID)}\n` };
      }
      if (line === '/usr/bin/dscl . -list /Users UniqueID') {
        return { code: 0, stdout: `root 0\n_tcjob 401\n_tcrunner ${String(OWN_UID)}\nowner 501\n` };
      }
      if (line === '/usr/bin/dscl . -list /Groups PrimaryGroupID') {
        return { code: 0, stdout: 'wheel 0\n_tcjob 401\n' };
      }
      if (line === '/usr/bin/dscl . -read /Users/_tcjob NFSHomeDirectory') {
        return { code: 0, stdout: 'NFSHomeDirectory: /var/empty\n' };
      }
      if (line === '/usr/bin/dscl . -read /Users/_tcjob UserShell') {
        return { code: 0, stdout: 'UserShell: /usr/bin/false\n' };
      }
      if (line.startsWith('/usr/bin/sudo -n -u _tcjob -- /usr/bin/env -i')) {
        return { code: [CLAUDE, '/usr/bin/git', NODE].includes(args.at(-2) ?? '') ? 0 : 1, stdout: '' };
      }
      if (line === '/usr/bin/sudo -n -l -U _tcrunner') {
        return { code: 0, stdout: `User _tcrunner may run the following commands on owner-mac:\n${state.sudoRules}` };
      }
      if (line.startsWith('/bin/launchctl print')) {
        return loaded ? { code: 0, stdout: '\tstate = running\n\tpid = 4242\n' } : { code: 113, stdout: '' };
      }
      if (line.startsWith('/bin/launchctl bootstrap') || line.startsWith('/bin/launchctl kickstart')) {
        loaded = true;
        return { code: 0, stdout: '' };
      }
      void options;
      // dseditgroup checkmember (not an admin), sudo -u _tcjob ls (refused) and anything unexpected: a refusal.
      return { code: 1, stdout: '' };
    };
    const host: SetupHost = {
      platform: 'darwin',
      uid: 0,
      homeDir: '/var/root',
      exec,
      stat: async (path) => {
        const local = mapped(path);
        if (local === null) {
          return stats[path] ?? null;
        }
        try {
          const facts = await lstat(local);
          const kind = facts.isSymbolicLink() ? 'symlink' : facts.isDirectory() ? 'directory' : facts.isFile() ? 'file' : 'other';
          return { uid: facts.uid, mode: facts.mode & 0o7777, kind, size: facts.size };
        } catch {
          // Missing on the fake Mac.
          return null;
        }
      },
      realpath: async (path) => (mapped(path) ?? (stats[path] === undefined ? null : path)),
      read: async (path) => files[path] ?? null,
      apply: async () => {
        throw new Error('the fake Mac is already installed; no step should run');
      },
      runAsRunner: async (args) => await runCli(args, childDeps((line) => (state.terminal += `${line}\n`))),
      queryAsRunner: async (args) => {
        let stdout = '';
        const code = await runCli(args, childDeps((line) => (stdout += `${line}\n`)));
        return { code, stdout };
      },
      list: async (path) => {
        const local = mapped(path);
        return local === null ? null : await readdir(local).catch(() => null);
      },
      sleep: () => Promise.resolve(),
      now: () => new Date(),
    };
    return Object.assign(state, { host });
  }

  const options = (overrides: Partial<SetupOptions> = {}): SetupOptions => ({
    url: API,
    enrolment: INTENT,
    fromPkg: false,
    credential: 'setup-token',
    replaceCredential: false,
    prefix: PREFIX,
    node: NODE,
    ...overrides,
  });

  const run = async (mac: World, overrides: Partial<SetupOptions> = {}): Promise<boolean> =>
    await runSetup(options(overrides), {
      host: mac.host,
      out: (line) => mac.rootOut.push(line),
      tmpRoot,
      openRequestChannel: () => openRequestChannel(tmpRoot, mac.host.exec),
      openForUser: async (url) => {
        mac.opened.push(url);
      },
      pollMs: 1,
      settleMs: 0,
    });

  it('enrols, finds the toolchain, captures the sign-in, starts the service and ends with «Готово»', async () => {
    const mac = world();
    await expect(run(mac)).resolves.toBe(true);

    expect(mac.rootOut.at(-1)).toBe('Готово: раннер «Owner Mac» на связи.');
    expect(mac.rootOut).toContain('ok   credential: setup-token, present, ' + String(TOKEN.length + 1) + ' bytes');
    expect(mac.rootOut).toContain('service: started com.team-console.runner');

    // The token: in the credential file, 0600, and nowhere root, the terminal or the console saw.
    const credential = join(home, 'credentials/claude-setup-token');
    expect(await readFile(credential, 'utf8')).toBe(`${TOKEN}\n`);
    expect((await stat(credential)).mode & 0o777).toBe(0o600);
    for (const seen of [mac.rootOut.join('\n'), mac.terminal, ...mac.requests.map((request) => request.url + request.body)]) {
      expect(seen).not.toContain(TOKEN.slice(13, 45));
    }
    for (const request of mac.requests) {
      expect(request.body).not.toMatch(/setup-token|api-key|credential|"length"|"bytes"/);
    }

    // What the operator saw: the fingerprint to compare and the CLI's own prompts; the page opened for them.
    expect(mac.terminal).toMatch(/Compare this code with the one in the console, then press «Подтвердить» \(Approve\) there: [0-9A-Z]{4}-[0-9A-Z]{4}/);
    expect(mac.terminal).toContain(SIGN_IN);
    expect(mac.opened).toEqual([SIGN_IN]);

    await expect(loadRunnerConfig(home)).resolves.toMatchObject({
      runnerId: RUNNER_ID,
      apiUrl: API,
      credential: { kind: 'setup-token', file: 'credentials/claude-setup-token' },
      toolchain: { claude: CLAUDE, path: '/opt/homebrew/bin:/usr/bin:/usr/local/bin:/bin:/usr/sbin:/sbin' },
    });
    // Nothing third-party ran as root: every --version probe is `sudo -u _tcjob`.
    expect(mac.execs.filter((line) => line.endsWith('--version')).every((line) => line.startsWith('/usr/bin/sudo -n -u _tcjob'))).toBe(true);
    // Homebrew's claude belongs to the login user: setup goes on and says so.
    expect(mac.rootOut.some((line) => line.startsWith('toolchain: warning: claude /opt/homebrew/bin/claude belongs to uid'))).toBe(true);
    expect(await readdir(tmpRoot)).toEqual([]);
  });

  it('is idempotent: a second run keeps the enrolment and the credential and restarts the service', async () => {
    const mac = world();
    await run(mac);
    const again = world();
    await expect(run(again)).resolves.toBe(true);
    expect(again.rootOut).toContain('enrol: already enrolled as «Owner Mac»; --enrolment is not used');
    expect(again.rootOut).toContain('credential: credentials/claude-setup-token is present and kept (--replace-credential to replace it)');
    expect(again.claudeRuns).toBe(0);
  });

  it('refuses a new runner without --url and --enrolment, before anything as _tcrunner', async () => {
    const mac = world();
    await expect(run(mac, { url: undefined, enrolment: undefined, only: ['enrol'] })).rejects.toThrow(
      /needs --url <console origin> and --enrolment/,
    );
    expect(await readdir(home)).toEqual(expect.not.arrayContaining(['config.json']));
  });

  it('refuses to re-enrol against another console', async () => {
    const mac = world();
    await run(mac);
    await expect(run(world(), { url: 'https://other.example', only: ['enrol'] })).rejects.toThrow(/enrolled with http:\/\/127\.0\.0\.1:22300/);
  });

  it('runs only the steps --only names, in setup order', async () => {
    const mac = world();
    await run(mac, { only: ['enrol', 'toolchain'] });
    expect(mac.claudeRuns).toBe(0);
    expect(mac.execs.some((line) => line.startsWith('/bin/launchctl'))).toBe(false);
  });

  it('self-check fails on a second sudoers rule and names it', async () => {
    const mac = world();
    await run(mac);
    const check = world();
    check.sudoRules += '    (root) NOPASSWD: /bin/sh\n';
    await expect(run(check, { only: ['check'] })).resolves.toBe(false);
    expect(check.rootOut).toContain(
      `FAIL L3-4 sudoers: _tcrunner must have exactly the rule "(_tcjob) NOPASSWD: ${PREFIX}/bin/job-exec" (found 2): check /etc/sudoers.d`,
    );
    // The service of this fresh fake Mac was never started, so that fails too, and comes first.
    expect(check.rootOut).toContain(
      'FAIL service: com.team-console.runner is not running: sudo launchctl bootstrap system /Library/LaunchDaemons/com.team-console.runner.plist, then see logs/runner.log',
    );
    expect(check.rootOut.at(-1)).toBe('Not ready: 2 check(s) failed; the first to fix: service.');
  });

  it('refuses --from-pkg with an enrolment, and anything but macOS as root', async () => {
    const mac = world();
    await expect(run(mac, { fromPkg: true })).rejects.toBeInstanceOf(SetupError);
    await expect(
      runSetup(options(), {
        host: { ...mac.host, uid: 501 },
        out: () => undefined,
        tmpRoot,
        openRequestChannel: () => openRequestChannel(tmpRoot),
        openForUser: () => Promise.resolve(),
      }),
    ).rejects.toThrow(/run it with sudo/);
  });

  describe('--release (R-ONE-1)', () => {
    async function release(): Promise<{ tarball: string; sha256: string }> {
      const tree = join(root, 'release');
      await mkdir(join(tree, 'bin'), { recursive: true });
      const files: Record<string, string> = {
        'team-console-runner.mjs': `console.log(${JSON.stringify(RUNNER_VERSION)});\n`,
        'bin/job-exec': '#!/bin/sh\n',
        'bin/team-console-runner': '#!/bin/sh\n',
      };
      const sums: string[] = [];
      for (const [name, content] of Object.entries(files)) {
        await writeFile(join(tree, name), content);
        sums.push(`${createHash('sha256').update(content).digest('hex')}  ${name}`);
      }
      await writeFile(join(tree, 'SHA256SUMS'), `${sums.join('\n')}\n`);
      const tarball = join(root, 'tcr.tgz');
      await hostExec('/usr/bin/tar', ['-czf', tarball, '-C', tree, 'SHA256SUMS', 'team-console-runner.mjs', 'bin']);
      return { tarball, sha256: createHash('sha256').update(await readFile(tarball)).digest('hex') };
    }

    const deps = (out: string[]) => ({
      host: { exec: (command: string, args: readonly string[]) => hostExec(command, args, { env: { PATH: '/usr/bin:/bin' } }) } as unknown as SetupHost,
      out: (line: string) => out.push(line),
      tmpRoot,
    });

    it('installs from a root-owned copy whose sum matches, and skips a release already live', async () => {
      const prefix = join(root, 'prefix');
      const out: string[] = [];
      await installRelease(await release(), deps(out), prefix);
      expect(await readFile(join(prefix, 'team-console-runner.mjs'), 'utf8')).toContain(RUNNER_VERSION);
      expect((await lstat(join(prefix, 'current'))).isSymbolicLink()).toBe(true);
      await installRelease(await release(), deps(out), prefix);
      expect(out.at(-1)).toBe(`install: release ${RUNNER_VERSION} is already in ${prefix}`);
      expect(await readdir(tmpRoot)).toEqual([]);
    });

    it('refuses a tarball that does not match the sum, installing nothing', async () => {
      const prefix = join(root, 'prefix');
      const { tarball } = await release();
      await expect(installRelease({ tarball, sha256: 'a'.repeat(64) }, deps([]), prefix)).rejects.toThrow(
        /does not match the sum the console named/,
      );
      await expect(stat(prefix)).rejects.toThrow();
      await expect(installRelease({ tarball, sha256: 'nope' }, deps([]), prefix)).rejects.toThrow(/64 hex/);
      expect(await readdir(tmpRoot)).toEqual([]);
    });
  });
});
