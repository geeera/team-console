import { chmod, mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CREDENTIAL_FILES, EnrolUsageError, checkEnrolOptions, enrol, type EnrolOptions } from '../cli/enrol';
import { parseRunnerConfig, type EnrolBackend } from '../config/config';
import { LaunchRefusal } from '../jobs/refusal';
import { ACCOUNT_ID, RUNNER_ID, fakeConsole, json, sentinels } from '../testing/fake-console';
import { runnerConfigFor } from '../testing/job-fixture';
import { buildJobEnv } from './env-builder';
import {
  INFERENCE_API_KEY_ENV,
  assertCredentialAllowed,
  isCredentialAllowed,
  jobCredentialOf,
  parseCredentialConfig,
  type CredentialConfig,
} from './credential';

/** ADR 0008 decision 5 (RR11): one credential kind per runner, each on its backends only. */

describe('credential kinds', () => {
  let home: string;

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'tcr-cred-'));
    await mkdir(join(home, 'credentials'), { mode: 0o700 });
  });

  afterEach(async () => {
    await rm(home, { recursive: true, force: true });
  });

  it('parses the three shapes and refuses anything else', () => {
    expect(parseCredentialConfig({ kind: 'api-key', file: 'credentials/anthropic.key' })).toEqual({
      kind: 'api-key',
      file: 'credentials/anthropic.key',
    });
    expect(parseCredentialConfig({ kind: 'claude-config-dir', path: '/Users/me/.claude' })).not.toBeNull();
    for (const bad of [
      { kind: 'api-key', file: '../keys/runner.key' },
      { kind: 'api-key', file: 'credentials/../x' },
      { kind: 'api-key', file: 'credentials/a', value: 'inline' },
      { kind: 'setup-token', path: '/x' },
      { kind: 'claude-config-dir', path: 'relative' },
      { kind: 'oauth', file: 'credentials/a' },
      'credentials/a',
    ]) {
      expect(parseCredentialConfig(bad)).toBeNull();
    }
  });

  it('reads an api-key file (0600) into ANTHROPIC_API_KEY on the none backend', async () => {
    await writeFile(join(home, 'credentials', 'anthropic.key'), `${sentinels.anthropicKey}\n`, {
      mode: 0o600,
    });
    await expect(
      jobCredentialOf(home, { kind: 'api-key', file: 'credentials/anthropic.key' }, 'none'),
    ).resolves.toEqual({ kind: 'api-key', name: 'ANTHROPIC_API_KEY', value: sentinels.anthropicKey });
  });

  it('refuses a subscription-shaped api-key file, and never echoes it', async () => {
    await writeFile(join(home, 'credentials', 'anthropic.key'), `${sentinels.subscriptionToken}\n`, {
      mode: 0o600,
    });
    const refused = jobCredentialOf(home, { kind: 'api-key', file: 'credentials/anthropic.key' }, 'none');
    await expect(refused).rejects.toMatchObject({ reason: 'credential-not-allowed' });
    const error: unknown = await refused.catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(LaunchRefusal);
    if (!(error instanceof LaunchRefusal)) {
      throw error;
    }
    expect(error.message).not.toContain(sentinels.subscriptionToken);
  });

  it('is null when no credential is configured', async () => {
    await expect(jobCredentialOf(home, undefined, 'none')).resolves.toBeNull();
  });

  it.each<[CredentialConfig, EnrolBackend]>([
    [{ kind: 'setup-token', file: 'credentials/claude-setup-token' }, 'none'],
    [{ kind: 'setup-token', file: 'credentials/claude-setup-token' }, 'container'],
    [{ kind: 'claude-config-dir', path: '/Users/me/.claude' }, 'none'],
    [{ kind: 'claude-config-dir', path: '/Users/me/.claude' }, 'user'],
  ])('refuses %o on the %s backend', async (credential, backend) => {
    await expect(jobCredentialOf(home, credential, backend)).rejects.toMatchObject({
      reason: 'credential-not-allowed',
    });
  });

  it('refuses a credential file others can read, and never names its value', async () => {
    const file = join(home, 'credentials', 'anthropic.key');
    await writeFile(file, sentinels.anthropicKey, { mode: 0o600 });
    await chmod(file, 0o644);
    const refusal: unknown = await jobCredentialOf(
      home,
      { kind: 'api-key', file: 'credentials/anthropic.key' },
      'none',
    ).catch((error: unknown) => error);
    expect(refusal).toBeInstanceOf(LaunchRefusal);
    expect(refusal).toMatchObject({ reason: 'credential-unreadable' });
    expect(String((refusal as Error).message)).not.toContain(sentinels.anthropicKey);
  });

  it('refuses a missing or empty credential file', async () => {
    await expect(
      jobCredentialOf(home, { kind: 'api-key', file: 'credentials/missing' }, 'none'),
    ).rejects.toMatchObject({ reason: 'credential-unreadable' });
    await writeFile(join(home, 'credentials', 'empty'), '\n', { mode: 0o600 });
    await expect(
      jobCredentialOf(home, { kind: 'api-key', file: 'credentials/empty' }, 'none'),
    ).rejects.toMatchObject({
      reason: 'credential-unreadable',
    });
  });
});

/**
 * RR11 end to end: every pairing decision 5 does not allow is refused at `enrol` (before the code is spent), in
 * `config.json` and at every launch, never a silent fallback; and no credential kind or value reaches the console.
 */
describe('RR11: credential/backend pairings', () => {
  const BACKENDS: readonly EnrolBackend[] = ['none', 'user', 'container'];
  const KINDS = ['api-key', 'setup-token', 'claude-config-dir'] as const;
  const ALLOWED = new Set([
    'api-key/none',
    'api-key/user',
    'api-key/container',
    'setup-token/user',
    'claude-config-dir/container',
  ]);
  const pairings = KINDS.flatMap((kind) => BACKENDS.map((backend) => [kind, backend] as const));
  const credentialOf = (kind: (typeof KINDS)[number]): CredentialConfig =>
    kind === 'claude-config-dir'
      ? { kind, path: '/Users/me/.claude' }
      : kind === 'api-key'
        ? { kind, file: CREDENTIAL_FILES[kind] }
        : { kind, file: CREDENTIAL_FILES[kind] };
  const enrolOptions = (kind: string, backend: string): EnrolOptions => ({
    url: 'http://127.0.0.1:22300',
    code: sentinels.enrolmentCode,
    backend,
    credential: kind,
    ...(kind === 'claude-config-dir' ? { claudeConfigDir: '/Users/me/.claude' } : {}),
  });

  it.each(pairings)(
    '%s on %s: allowed or refused alike at enrol, in config.json and at launch',
    (kind, backend) => {
      const atEnrol = (): unknown => checkEnrolOptions(enrolOptions(kind, backend));
      const inConfig = (): unknown =>
        parseRunnerConfig({ ...runnerConfigFor('/repo'), backend, credential: credentialOf(kind) });
      const atLaunch = (): void => assertCredentialAllowed(credentialOf(kind), backend);
      if (ALLOWED.has(`${kind}/${backend}`)) {
        expect(atEnrol()).toMatchObject({ credential: credentialOf(kind) });
        expect(inConfig()).toMatchObject({ credential: credentialOf(kind) });
        expect(atLaunch).not.toThrow();
      } else {
        expect(atEnrol).toThrow(EnrolUsageError);
        expect(atEnrol).toThrow(/is not allowed with --backend/);
        expect(inConfig).toThrow(/is not allowed on the/);
        expect(atLaunch).toThrow(LaunchRefusal);
      }
    },
  );

  it('refuses an unknown kind and a config dir without its kind', () => {
    expect(() => checkEnrolOptions(enrolOptions('oauth', 'user'))).toThrow(/--credential must be/);
    expect(() =>
      checkEnrolOptions({ ...enrolOptions('api-key', 'container'), claudeConfigDir: '/x' }),
    ).toThrow(/and only it/);
    expect(() =>
      checkEnrolOptions({ ...enrolOptions('claude-config-dir', 'container'), claudeConfigDir: 'relative' }),
    ).toThrow(/needs --claude-config-dir/);
    expect(() =>
      checkEnrolOptions({ ...enrolOptions('api-key', 'none'), credential: undefined, claudeConfigDir: '/x' }),
    ).toThrow(/needs --credential claude-config-dir/);
  });

  it('never posts the credential kind or value to the console', async () => {
    const parent = await mkdtemp(join(tmpdir(), 'tcr-rr11-'));
    try {
      const fake = fakeConsole(() =>
        json(201, {
          runnerId: RUNNER_ID,
          accountId: ACCOUNT_ID,
          name: 'Owner Mac',
          audience: 'team-console:local',
          allowedProjects: [],
          pollSeconds: 60,
        }),
      );
      const config = await enrol(enrolOptions('setup-token', 'user'), {
        home: join(parent, 'home'),
        fetch: fake.fetch,
        host: { os: 'darwin', arch: 'arm64', hostname: 'mac' },
      });
      expect(config.credential).toEqual({ kind: 'setup-token', file: 'credentials/claude-setup-token' });
      const body = fake.requests.map((request) => request.body ?? '').join('\n');
      for (const word of [
        'setup-token',
        'credential',
        'api-key',
        'claude-config-dir',
        'CLAUDE_CODE_OAUTH_TOKEN',
      ]) {
        expect(body).not.toContain(word);
      }
      expect(Object.keys(JSON.parse(body) as Record<string, unknown>).sort()).toEqual([
        'capabilities',
        'code',
        'host',
        'isolation',
        'publicKey',
        'version',
      ]);
      expect((await stat(join(parent, 'home', 'credentials'))).mode & 0o777).toBe(0o700);
    } finally {
      await rm(parent, { recursive: true, force: true });
    }
  });
});

/** #669: the `api-key` kind read from the runner's env, the one credential an `actions-ephemeral` run takes. */
describe('the api-key credential from TC_INFERENCE_API_KEY', () => {
  const fromEnv = { kind: 'api-key', env: INFERENCE_API_KEY_ENV } as const satisfies CredentialConfig;
  const source = { [INFERENCE_API_KEY_ENV]: sentinels.anthropicKey };

  it('parses only with the fixed variable name', () => {
    expect(parseCredentialConfig({ kind: 'api-key', env: 'TC_INFERENCE_API_KEY' })).toEqual(fromEnv);
    for (const bad of [
      { kind: 'api-key', env: 'ANTHROPIC_API_KEY' },
      { kind: 'api-key', env: 'TC_INFERENCE_API_KEY', file: 'credentials/a' },
      { kind: 'setup-token', env: 'TC_INFERENCE_API_KEY' },
      { kind: 'claude-config-dir', env: 'TC_INFERENCE_API_KEY' },
    ]) {
      expect(parseCredentialConfig(bad)).toBeNull();
    }
  });

  it('is accepted on actions-ephemeral only, and actions-ephemeral takes no other credential', () => {
    expect(isCredentialAllowed(fromEnv, 'actions-ephemeral')).toBe(true);
    for (const backend of ['none', 'user', 'container'] as const) {
      expect(isCredentialAllowed(fromEnv, backend)).toBe(false);
      expect(() => assertCredentialAllowed(fromEnv, backend)).toThrow(
        /api-key credential from TC_INFERENCE_API_KEY is not allowed/,
      );
    }
    for (const other of [
      { kind: 'api-key', file: 'credentials/anthropic.key' },
      { kind: 'setup-token', file: 'credentials/claude-setup-token' },
      { kind: 'claude-config-dir', path: '/Users/me/.claude' },
    ] as const satisfies readonly CredentialConfig[]) {
      expect(isCredentialAllowed(other, 'actions-ephemeral')).toBe(false);
      expect(() => assertCredentialAllowed(other, 'actions-ephemeral')).toThrow(LaunchRefusal);
    }
  });

  it('is refused in config.json, whose backends never include actions-ephemeral', () => {
    expect(() => parseRunnerConfig({ ...runnerConfigFor('/repo'), credential: fromEnv })).toThrow(
      /the api-key credential is not allowed on the none backend/,
    );
    expect(() => parseRunnerConfig({ ...runnerConfigFor('/repo'), backend: 'actions-ephemeral' })).toThrow(
      /backend must be one of container, user, none/,
    );
    expect(() =>
      parseRunnerConfig({ ...runnerConfigFor('/repo'), vcs: { readToken: sentinels.githubToken } }),
    ).toThrow(/unknown key "vcs"/);
  });

  it('reads the key from the runner’s env into ANTHROPIC_API_KEY, and nothing from the home', async () => {
    await expect(jobCredentialOf('/nonexistent', fromEnv, 'actions-ephemeral', source)).resolves.toEqual({
      kind: 'api-key',
      name: 'ANTHROPIC_API_KEY',
      value: sentinels.anthropicKey,
    });
  });

  it.each([
    ['missing', {}],
    ['empty', { [INFERENCE_API_KEY_ENV]: '' }],
    ['two-line', { [INFERENCE_API_KEY_ENV]: `${sentinels.anthropicKey}\nsecond` }],
    ['too short', { [INFERENCE_API_KEY_ENV]: 'short' }],
  ])('refuses a %s key without quoting it', async (_label, env) => {
    const refused = jobCredentialOf('/nonexistent', fromEnv, 'actions-ephemeral', env);
    await expect(refused).rejects.toThrow(LaunchRefusal);
    await expect(refused).rejects.toThrow(/^TC_INFERENCE_API_KEY does not hold one credential line$/);
  });

  it('refuses a subscription-shaped value, and never echoes it', async () => {
    const refused = jobCredentialOf('/nonexistent', fromEnv, 'actions-ephemeral', {
      [INFERENCE_API_KEY_ENV]: sentinels.subscriptionToken,
    });
    await expect(refused).rejects.toMatchObject({ reason: 'credential-not-allowed' });
    const error: unknown = await refused.catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(LaunchRefusal);
    if (!(error instanceof LaunchRefusal)) {
      throw error;
    }
    expect(error.message).not.toContain(sentinels.subscriptionToken);
  });

  it('still refuses an OAuth kind on an Actions job', () => {
    for (const credential of [
      { kind: 'setup-token', name: 'CLAUDE_CODE_OAUTH_TOKEN', value: 'x'.repeat(20) },
      { kind: 'claude-config-dir', name: 'CLAUDE_CONFIG_DIR', value: '/home/job/.claude' },
    ] as const) {
      expect(() =>
        buildJobEnv({
          jobToken: sentinels.jobToken,
          projectSlug: 'team-console',
          consoleUrl: 'https://console.example',
          socketPath: '/tmp/s',
          home: '/tmp/h',
          tmp: '/tmp/t',
          toolchainPath: '/usr/bin',
          dispatch: 'actions',
          credential,
          accessSource: null,
          passthrough: [],
          source: {},
        }),
      ).toThrow(/never runs a actions job/);
    }
  });
});
