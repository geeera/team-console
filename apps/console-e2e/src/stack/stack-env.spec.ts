import { randomBytes } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { STACK_ENV_ALLOWLIST, stackChildEnv, stackHome, type StackHome } from './stack-env';

const RUN_HOME: StackHome = {
  HOME: '/run/home',
  XDG_CONFIG_HOME: '/run/home/.config',
  XDG_CACHE_HOME: '/run/home/.cache',
};

/** A host environment with what a developer's shell or a CI job holds; the values are made up per run. */
function hostEnv(): NodeJS.ProcessEnv {
  const made = (): string => randomBytes(16).toString('hex');
  return {
    PATH: '/usr/local/bin:/usr/bin',
    HOME: '/home/dev',
    XDG_CONFIG_HOME: '/home/dev/.config',
    XDG_CACHE_HOME: '/home/dev/.cache',
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
    const env = stackChildEnv(hostEnv(), RUN_HOME, { SERVE_WORKER_OPTIONS: '{}', FORCE_COLOR: '0' });

    expect(env).toEqual({
      PATH: '/usr/local/bin:/usr/bin',
      ...RUN_HOME,
      TMPDIR: '/tmp/dev',
      LANG: 'en_US.UTF-8',
      CI: 'true',
      SERVE_WORKER_OPTIONS: '{}',
      FORCE_COLOR: '0',
    });
  });

  it('never passes a host value of any name outside the allowlist', () => {
    const host = hostEnv();
    const env = stackChildEnv(host, RUN_HOME, {});
    const allowed: readonly string[] = STACK_ENV_ALLOWLIST;

    for (const [name, value] of Object.entries(host)) {
      if (!allowed.includes(name)) {
        // A home name is there, with the run's value; no host value of any such name is.
        expect(env[name]).toBe((RUN_HOME as unknown as Record<string, string | undefined>)[name]);
        expect(Object.values(env)).not.toContain(value);
      }
    }
  });

  it('lets what the stack sets win over an inherited value of the same name', () => {
    expect(stackChildEnv({ CI: 'true' }, RUN_HOME, { CI: 'false' })).toEqual({ ...RUN_HOME, CI: 'false' });
  });

  it('leaves out an allowlisted name the host does not have', () => {
    expect(stackChildEnv({ PATH: '/bin' }, RUN_HOME, {})).toEqual({ ...RUN_HOME, PATH: '/bin' });
  });

  it('gives a child the home of the run, never the one of the host, and lets no caller put the real one back', () => {
    const host = hostEnv();
    const env = stackChildEnv(host, RUN_HOME, { HOME: '/home/dev', XDG_CONFIG_HOME: '/home/dev/.config' });

    expect(env).toMatchObject(RUN_HOME);
    expect(Object.values(env).filter((value) => value.startsWith('/home/dev'))).toEqual([]);
  });

  it('allows no name that can carry a credential, preload code or reach the network', () => {
    expect([...STACK_ENV_ALLOWLIST].sort()).toEqual(
      ['CI', 'LANG', 'LC_ALL', 'LOGNAME', 'PATH', 'TMPDIR', 'USER'].sort(),
    );
  });
});

describe('stackHome', () => {
  it('makes an empty home of its own for the run under the stacks directory, for the owner only', () => {
    const stacksDir = mkdtempSync(join(tmpdir(), 'stack-home-'));
    try {
      const home = stackHome(stacksDir);

      expect(home).toEqual({
        HOME: join(stacksDir, 'home'),
        XDG_CONFIG_HOME: join(stacksDir, 'home/.config'),
        XDG_CACHE_HOME: join(stacksDir, 'home/.cache'),
      });
      expect(readdirSync(home.HOME).sort()).toEqual(['.cache', '.config']);
      expect(readdirSync(home.XDG_CONFIG_HOME)).toEqual([]);
      expect(statSync(home.HOME).mode & 0o777).toBe(0o700);
      expect(stackHome(stacksDir)).toEqual(home);
    } finally {
      rmSync(stacksDir, { recursive: true, force: true });
    }
  });

  it('closes a home that is already there and open to others, its config and cache too', () => {
    const stacksDir = mkdtempSync(join(tmpdir(), 'stack-home-'));
    try {
      const open = [join(stacksDir, 'home'), join(stacksDir, 'home/.config'), join(stacksDir, 'home/.cache')];
      for (const dir of open) {
        mkdirSync(dir);
        // Past the umask, which would have closed part of it already.
        chmodSync(dir, 0o777);
      }

      stackHome(stacksDir);

      expect(open.map((dir) => statSync(dir).mode & 0o777)).toEqual([0o700, 0o700, 0o700]);
    } finally {
      rmSync(stacksDir, { recursive: true, force: true });
    }
  });

  it('refuses a home that is a link, and leaves what the link names as it was', () => {
    const stacksDir = mkdtempSync(join(tmpdir(), 'stack-home-'));
    try {
      const real = join(stacksDir, 'the-real-home');
      mkdirSync(real);
      chmodSync(real, 0o755);
      symlinkSync(real, join(stacksDir, 'home'));

      expect(() => stackHome(stacksDir)).toThrow(/home is a symbolic link/);

      expect(statSync(real).mode & 0o777).toBe(0o755);
      expect(readdirSync(real)).toEqual([]);
    } finally {
      rmSync(stacksDir, { recursive: true, force: true });
    }
  });

  it('refuses a config directory that is a link inside a home of its own', () => {
    const stacksDir = mkdtempSync(join(tmpdir(), 'stack-home-'));
    try {
      const real = join(stacksDir, 'the-real-config');
      mkdirSync(real);
      chmodSync(real, 0o755);
      mkdirSync(join(stacksDir, 'home'));
      symlinkSync(real, join(stacksDir, 'home/.config'));

      expect(() => stackHome(stacksDir)).toThrow(/\.config is a symbolic link/);

      expect(statSync(real).mode & 0o777).toBe(0o755);
      expect(existsSync(join(stacksDir, 'home/.cache'))).toBe(false);
    } finally {
      rmSync(stacksDir, { recursive: true, force: true });
    }
  });

  it('refuses a link that names nothing, and a file where the home should be', () => {
    const stacksDir = mkdtempSync(join(tmpdir(), 'stack-home-'));
    try {
      symlinkSync(join(stacksDir, 'nowhere'), join(stacksDir, 'home'));
      expect(() => stackHome(stacksDir)).toThrow();
      expect(existsSync(join(stacksDir, 'nowhere'))).toBe(false);

      rmSync(join(stacksDir, 'home'));
      writeFileSync(join(stacksDir, 'home'), '');
      expect(() => stackHome(stacksDir)).toThrow();
    } finally {
      rmSync(stacksDir, { recursive: true, force: true });
    }
  });
});
