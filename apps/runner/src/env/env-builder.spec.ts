import type { JobDispatch } from '@shared/contracts';
import { LaunchRefusal } from '../jobs/refusal';
import { sentinels } from '../testing/fake-console';
import type { JobCredential } from './credential';
import { buildJobEnv, type JobEnvInput } from './env-builder';

/** Threat model C3 cross-job row (a) and ADR 0008 decisions 4–5: the job env is built from nothing. */

const base: JobEnvInput = {
  jobToken: sentinels.jobToken,
  projectSlug: 'team-console',
  consoleUrl: 'https://console.example',
  socketPath: '/r/jobs/J/sock/tc.sock',
  home: '/r/jobs/J/home',
  tmp: '/r/jobs/J/tmp',
  toolchainPath: '/opt/tc/bin:/usr/bin:/bin',
  dispatch: 'pull',
  credential: null,
  passthrough: [],
  source: {
    PATH: '/runner/own/path',
    HOME: '/Users/runner',
    ANTHROPIC_API_KEY: sentinels.anthropicKey,
    CLAUDE_CODE_OAUTH_TOKEN: 'oauth',
    GH_TOKEN: sentinels.githubToken,
    NODE_OPTIONS: '--require /tmp/evil.js',
    SSH_AUTH_SOCK: '/tmp/agent.sock',
    PT_REPO: 'geeera/team-console',
  },
};

const apiKey: JobCredential = { kind: 'api-key', name: 'ANTHROPIC_API_KEY', value: sentinels.anthropicKey };
const setupToken: JobCredential = {
  kind: 'setup-token',
  name: 'CLAUDE_CODE_OAUTH_TOKEN',
  value: 'oauth-token',
};
const configDir: JobCredential = {
  kind: 'claude-config-dir',
  name: 'CLAUDE_CONFIG_DIR',
  value: '/home/job/.claude',
};

function refusalOf(input: JobEnvInput): LaunchRefusal {
  try {
    buildJobEnv(input);
  } catch (error: unknown) {
    if (error instanceof LaunchRefusal) {
      return error;
    }
    throw error;
  }
  throw new Error('expected a refusal');
}

describe('env-builder (ADR 0008 decision 4)', () => {
  it('returns exactly the listed variables and inherits none of the runner’s', () => {
    const { env, passedThrough } = buildJobEnv(base);
    expect(env).toEqual({
      TC_API_URL: 'http://tc/api/v1',
      TC_RUNNER_SOCKET: '/r/jobs/J/sock/tc.sock',
      TC_JOB_TOKEN: sentinels.jobToken,
      TC_PROJECT: 'team-console',
      TC_CONSOLE_URL: 'https://console.example',
      HOME: '/r/jobs/J/home',
      TMPDIR: '/r/jobs/J/tmp',
      PATH: '/opt/tc/bin:/usr/bin:/bin',
      LANG: 'en_US.UTF-8',
      TZ: 'UTC',
      DISABLE_AUTOUPDATER: '1',
    });
    expect(passedThrough).toEqual([]);
  });

  it('adds an allow-listed passthrough name and reports it for the notice', () => {
    const { env, passedThrough } = buildJobEnv({ ...base, passthrough: ['PT_REPO', 'PT_UNSET'] });
    expect(env['PT_REPO']).toBe('geeera/team-console');
    expect('PT_UNSET' in env).toBe(false);
    expect(passedThrough).toEqual(['PT_REPO']);
  });

  it.each([
    ['GH_TOKEN', '*_TOKEN'],
    ['OPENAI_API_KEY', '*_API_KEY'],
    ['MY_SECRET_VALUE', '*SECRET*'],
    ['ANTHROPIC_API_KEY', '*_API_KEY'],
    ['ANTHROPIC_BASE_URL', 'ANTHROPIC_*'],
    ['CLAUDE_CODE_OAUTH_TOKEN', '*_TOKEN'],
    ['CLAUDE_CONFIG_DIR', 'CLAUDE_*'],
    ['TC_EXTRA', 'TC_*'],
  ])('refuses the passthrough name %s (%s)', (name, label) => {
    const refusal = refusalOf({ ...base, passthrough: ['PT_REPO', name] });
    expect(refusal.reason).toBe('env-passthrough-refused');
    expect(refusal.message).toContain(label);
  });

  it.each(['HOME', 'PATH', 'LANG', 'lower_case', 'BAD-NAME', ''])(
    'refuses %j as a passthrough name (reserved or malformed)',
    (name) => {
      expect(refusalOf({ ...base, passthrough: [name] }).reason).toBe('env-passthrough-refused');
    },
  );

  it('sets the one credential variable from decision 5', () => {
    expect(buildJobEnv({ ...base, credential: apiKey }).env['ANTHROPIC_API_KEY']).toBe(
      sentinels.anthropicKey,
    );
    expect(buildJobEnv({ ...base, credential: setupToken }).env['CLAUDE_CODE_OAUTH_TOKEN']).toBe(
      'oauth-token',
    );
  });

  it('refuses a credential under another variable name', () => {
    const refusal = refusalOf({ ...base, credential: { ...apiKey, name: 'NODE_OPTIONS' } });
    expect(refusal.reason).toBe('credential-not-allowed');
  });

  it.each<[JobCredential, JobDispatch]>([
    [setupToken, 'hosted'],
    [setupToken, 'actions'],
    [configDir, 'hosted'],
    [configDir, 'actions'],
  ])('refuses a Claude OAuth credential (%o) on a %s job', (credential, dispatch) => {
    expect(refusalOf({ ...base, credential, dispatch }).reason).toBe('oauth-on-hosted');
  });

  it('allows an API key on a hosted or Actions job', () => {
    expect(
      buildJobEnv({ ...base, credential: apiKey, dispatch: 'actions' }).env['ANTHROPIC_API_KEY'],
    ).toBeDefined();
    expect(
      buildJobEnv({ ...base, credential: apiKey, dispatch: 'hosted' }).env['ANTHROPIC_API_KEY'],
    ).toBeDefined();
  });

  it('never names a value in a refusal', () => {
    const refusal = refusalOf({ ...base, passthrough: ['GH_TOKEN'] });
    expect(refusal.message).not.toContain(sentinels.githubToken);
  });
});
