import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { STACK_ENV_ALLOWLIST, stackChildEnv } from './stack-env';

/** A host environment with what a developer's shell or a CI job holds; the values are made up per run. */
function hostEnv(): NodeJS.ProcessEnv {
  const made = (): string => randomBytes(16).toString('hex');
  return {
    PATH: '/usr/local/bin:/usr/bin',
    HOME: '/home/dev',
    TMPDIR: '/tmp/dev',
    LANG: 'en_US.UTF-8',
    CI: 'true',
    CLOUDFLARE_API_TOKEN: made(),
    CLOUDFLARE_ACCOUNT_ID: made(),
    GITHUB_TOKEN: made(),
    NODE_AUTH_TOKEN: made(),
    CF_ACCESS_CLIENT_ID: made(),
    CF_ACCESS_CLIENT_SECRET: made(),
    TOKEN_ENCRYPTION_KEY: made(),
    NODE_OPTIONS: '--inspect=0.0.0.0:9229',
    HTTPS_PROXY: 'http://proxy.invalid:3128',
    BASE_URL: 'https://stage.invalid',
    FORCE_COLOR: '1',
  };
}

describe('stackChildEnv', () => {
  it('hands a child the allowlisted names and what the stack sets, nothing else from the host', () => {
    const env = stackChildEnv(hostEnv(), { SERVE_WORKER_OPTIONS: '{}', FORCE_COLOR: '0' });

    expect(env).toEqual({
      PATH: '/usr/local/bin:/usr/bin',
      HOME: '/home/dev',
      TMPDIR: '/tmp/dev',
      LANG: 'en_US.UTF-8',
      CI: 'true',
      SERVE_WORKER_OPTIONS: '{}',
      FORCE_COLOR: '0',
    });
  });

  it('never passes a host value of any name outside the allowlist', () => {
    const host = hostEnv();
    const env = stackChildEnv(host, {});
    const allowed: readonly string[] = STACK_ENV_ALLOWLIST;

    for (const [name, value] of Object.entries(host)) {
      if (!allowed.includes(name)) {
        expect(env).not.toHaveProperty(name);
        expect(Object.values(env)).not.toContain(value);
      }
    }
  });

  it('lets what the stack sets win over an inherited value of the same name', () => {
    expect(stackChildEnv({ CI: 'true' }, { CI: 'false' })).toEqual({ CI: 'false' });
  });

  it('leaves out an allowlisted name the host does not have', () => {
    expect(stackChildEnv({ PATH: '/bin' }, {})).toEqual({ PATH: '/bin' });
  });

  it('allows no name that can carry a credential, preload code or reach the network', () => {
    expect([...STACK_ENV_ALLOWLIST].sort()).toEqual(
      [
        'CI',
        'HOME',
        'LANG',
        'LC_ALL',
        'LOGNAME',
        'PATH',
        'TMPDIR',
        'USER',
        'XDG_CACHE_HOME',
        'XDG_CONFIG_HOME',
      ].sort(),
    );
  });
});
