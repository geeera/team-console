import { RUNNER_GIT_ENV_ALLOWED, runnerGitEnv } from './git';

/** #591: the mirror fetch sees an allow-list of the runner's env, never the rest of it. */

describe('runnerGitEnv', () => {
  it('passes HOME, PATH, the ssh agent and the proxy/TLS variables', () => {
    const source = Object.fromEntries(RUNNER_GIT_ENV_ALLOWED.map((name) => [name, `v-${name}`]));
    expect(runnerGitEnv(source)).toEqual({ ...source, GIT_TERMINAL_PROMPT: '0', LC_ALL: 'C' });
  });

  it.each(['XDG_CONFIG_HOME', 'KRB5CCNAME', 'GNUPGHOME'])('passes %s to the mirror fetch (#648)', (name) => {
    expect(runnerGitEnv({ [name]: '/operator/path' })).toEqual({
      [name]: '/operator/path',
      GIT_TERMINAL_PROMPT: '0',
      LC_ALL: 'C',
    });
  });

  it.each(['SSH_ASKPASS', 'SSH_ASKPASS_REQUIRE', 'GIT_ASKPASS', 'GIT_SSL_NO_VERIFY', 'GIT_SSH_COMMAND', 'LD_PRELOAD'])(
    'still refuses %s: it names a program or weakens TLS',
    (name) => {
      expect(runnerGitEnv({ [name]: 'x' })).toEqual({ GIT_TERMINAL_PROMPT: '0', LC_ALL: 'C' });
    },
  );

  it('drops every other variable of the runner, secrets included', () => {
    expect(
      runnerGitEnv({
        HOME: '/runner',
        PATH: '/usr/bin',
        ANTHROPIC_API_KEY: 'sk-ant-x',
        TC_RUNNER_TOKEN: 't',
        LD_PRELOAD: '/tmp/x.so',
        DYLD_INSERT_LIBRARIES: '/tmp/x.dylib',
        XDG_DATA_HOME: '/tmp/xdg',
      }),
    ).toEqual({ HOME: '/runner', PATH: '/usr/bin', GIT_TERMINAL_PROMPT: '0', LC_ALL: 'C' });
  });

  it('drops every GIT_* of the runner, setting its own prompt and locale', () => {
    expect(
      runnerGitEnv({
        PATH: '/usr/bin',
        GIT_CONFIG_COUNT: '1',
        GIT_CONFIG_KEY_0: 'core.fsmonitor',
        GIT_SSH_COMMAND: 'evil',
        GIT_TERMINAL_PROMPT: '1',
        LC_ALL: 'de_DE.UTF-8',
      }),
    ).toEqual({ PATH: '/usr/bin', GIT_TERMINAL_PROMPT: '0', LC_ALL: 'C' });
  });

  it('skips allowed variables that are unset', () => {
    expect(runnerGitEnv({ HOME: undefined })).toEqual({ GIT_TERMINAL_PROMPT: '0', LC_ALL: 'C' });
  });
});
