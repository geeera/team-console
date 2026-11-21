import { chmod, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadRunnerConfig, saveRunnerConfig, type RunnerConfig } from '../config/config';
import { ACCOUNT_ID, RUNNER_ID } from '../testing/fake-console';
import { CredentialSetupError, hostSpawnClaude, setUpCredential, type CredentialSetupDeps } from './credential';

const TOKEN = `sk-ant-oat01-${'Qw7_-'.repeat(20)}end`;
const API_KEY = `sk-ant-api03-${'Qw7_-'.repeat(20)}`;

const enrolled: RunnerConfig = {
  schema: 1,
  apiUrl: 'https://team-console-dev.geeera.workers.dev',
  runnerId: RUNNER_ID,
  accountId: ACCOUNT_ID,
  name: 'Owner Mac',
  audience: 'team-console:dev',
  projectScope: 'all',
  allowedProjects: [],
  pollSeconds: 60,
  backend: 'user',
};

const modeOf = async (path: string): Promise<number> => (await stat(path)).mode & 0o777;

describe('setup-credential (#634 PR 2, R-TOK-1…3)', () => {
  let root: string;
  let home: string;
  let tmpRoot: string;
  let terminal: string;
  let logs: string[];

  /** A stand-in for `claude`: prints what `body` says and leaves login state in its HOME, as the real CLI does. */
  async function fakeClaude(body: string): Promise<string> {
    const path = join(root, 'claude');
    await writeFile(
      path,
      [
        '#!/bin/sh',
        '[ "$1" = setup-token ] || exit 64',
        'printf "%s" "$HOME" > "$(dirname "$0")/seen-home"',
        'echo "{}" > "$HOME/.claude.json"',
        'mkdir -p "$HOME/.claude" && echo secret > "$HOME/.claude/.credentials.json"',
        body,
        '',
      ].join('\n'),
    );
    await chmod(path, 0o755);
    return path;
  }

  function deps(overrides: Partial<CredentialSetupDeps> = {}): CredentialSetupDeps {
    return {
      home,
      config: enrolled,
      terminal: { stdout: (text) => (terminal += text), stderr: (text) => (terminal += text) },
      log: (line) => logs.push(line),
      tmpRoot,
      spawnClaude: hostSpawnClaude,
      ...overrides,
    };
  }

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'tcr-credential-'));
    home = join(root, 'home');
    tmpRoot = join(root, 'tmp');
    await mkdir(home, { mode: 0o700 });
    await mkdir(tmpRoot, { mode: 0o700 });
    await saveRunnerConfig(home, enrolled);
    terminal = '';
    logs = [];
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('captures the token into credentials/claude-setup-token 0600, shows the prompts and never the token', async () => {
    const claude = await fakeClaude(
      [
        'echo "Browser didn\'t open? Use the url below to sign in:"',
        'echo "https://claude.ai/oauth/authorize?code=true&state=abc"',
        'printf "Paste code here if prompted > "',
        `printf '\\033[32m✓\\033[0m Token:\\n${TOKEN}\\nStore this token securely.\\n'`,
      ].join('\n'),
    );
    const requests = join(root, 'open-requests');
    await writeFile(requests, '', { mode: 0o600 });
    const bytes = await setUpCredential(deps({ openRequests: requests }), {
      kind: 'setup-token',
      replace: false,
      claude,
      path: '/usr/bin:/bin',
    });

    const file = join(home, 'credentials/claude-setup-token');
    expect(await readFile(file, 'utf8')).toBe(`${TOKEN}\n`);
    expect(await modeOf(file)).toBe(0o600);
    expect(bytes).toBe(TOKEN.length + 1);
    expect(terminal).toContain('https://claude.ai/oauth/authorize?code=true&state=abc');
    expect(terminal).toContain('Paste code here if prompted > ');
    expect(terminal).not.toContain(TOKEN.slice(13, 40));
    expect(logs).toEqual([`credential: setup-token written (${String(bytes)} bytes)`]);
    expect(logs.join('\n')).not.toContain(TOKEN);
    expect(await readFile(requests, 'utf8')).toBe('https://claude.ai/oauth/authorize?code=true&state=abc\n');
    await expect(loadRunnerConfig(home)).resolves.toMatchObject({
      credential: { kind: 'setup-token', file: 'credentials/claude-setup-token' },
    });

    // The CLI's HOME was a fresh 0700 directory outside the runner's home, and it is gone with its login state.
    const seenHome = await readFile(join(root, 'seen-home'), 'utf8');
    expect(seenHome.startsWith(`${tmpRoot}/tcr-claude-`)).toBe(true);
    expect(await readdir(tmpRoot)).toEqual([]);
    expect((await readdir(home)).sort()).toEqual(['config.json', 'credentials']);
    expect(await readdir(join(home, 'credentials'))).toEqual(['claude-setup-token']);
  });

  it.each<[string, string, RegExp]>([
    ['a token wrapped across two lines', `printf '${TOKEN.slice(0, 50)}\\n${TOKEN.slice(50)}\\n'`, /across lines/],
    ['a token on stderr next to another on stdout', `echo ${TOKEN}; echo sk-ant-oat01-${'x'.repeat(40)} >&2`, /two different/],
    ['an API key', `echo ${API_KEY}`, /API key/],
    ['nothing at all', 'echo "Login cancelled"', /no token/],
    ['a non-zero exit after a token', `echo ${TOKEN}; exit 3`, /exited 3/],
  ])('writes nothing and shows nothing of the key for %s', async (_case, body, message) => {
    const claude = await fakeClaude(body);
    await expect(
      setUpCredential(deps(), { kind: 'setup-token', replace: false, claude, path: '/usr/bin:/bin' }),
    ).rejects.toThrow(message);
    expect(await readdir(join(home, 'credentials'))).toEqual([]);
    expect(terminal).not.toContain('sk-ant-');
    expect(terminal).not.toContain(TOKEN.slice(20, 40));
    expect(await readdir(tmpRoot)).toEqual([]);
    await expect(loadRunnerConfig(home)).resolves.toEqual(enrolled);
  });

  it('refuses to replace an existing token without --replace, before the sign-in', async () => {
    const claude = await fakeClaude(`echo ${TOKEN}`);
    await mkdir(join(home, 'credentials'), { mode: 0o700 });
    await writeFile(join(home, 'credentials/claude-setup-token'), 'old\n', { mode: 0o600 });
    await expect(
      setUpCredential(deps(), { kind: 'setup-token', replace: false, claude, path: '/usr/bin:/bin' }),
    ).rejects.toThrow(/--replace/);
    await expect(readFile(join(root, 'seen-home'), 'utf8')).rejects.toThrow();
    await setUpCredential(deps(), { kind: 'setup-token', replace: true, claude, path: '/usr/bin:/bin' });
    expect(await readFile(join(home, 'credentials/claude-setup-token'), 'utf8')).toBe(`${TOKEN}\n`);
  });

  it('refuses to switch a configured api-key runner to a setup-token without --replace', async () => {
    const other = join(root, 'other');
    await mkdir(other, { mode: 0o700 });
    const config = { ...enrolled, credential: { kind: 'api-key', file: 'credentials/anthropic.key' } } as const;
    await saveRunnerConfig(other, config);
    await expect(
      setUpCredential(deps({ home: other, config }), {
        kind: 'setup-token',
        replace: false,
        claude: '/nonexistent',
        path: '/usr/bin:/bin',
      }),
    ).rejects.toBeInstanceOf(CredentialSetupError);
  });

  it('refuses a setup-token on a backend that may not use one', async () => {
    await expect(
      setUpCredential(deps({ config: { ...enrolled, backend: 'container' } }), {
        kind: 'setup-token',
        replace: false,
        claude: '/nonexistent',
        path: '/usr/bin:/bin',
      }),
    ).rejects.toThrow(/not allowed on the container backend/);
  });

  describe('api-key', () => {
    const apiKey = (line: string): Promise<number> =>
      setUpCredential(deps({ readHiddenLine: () => Promise.resolve(line) }), {
        kind: 'api-key',
        replace: false,
        claude: '/nonexistent',
        path: '/usr/bin:/bin',
      });

    it('writes a key read with echo off', async () => {
      await apiKey(`${API_KEY}\n`);
      expect(await readFile(join(home, 'credentials/anthropic.key'), 'utf8')).toBe(`${API_KEY}\n`);
      await expect(loadRunnerConfig(home)).resolves.toMatchObject({ credential: { kind: 'api-key' } });
    });

    it.each([TOKEN, 'not-a-key'])('refuses %s, writing nothing', async (line) => {
      await expect(apiKey(line)).rejects.toBeInstanceOf(CredentialSetupError);
      expect(await readdir(join(home, 'credentials'))).toEqual([]);
    });
  });
});
