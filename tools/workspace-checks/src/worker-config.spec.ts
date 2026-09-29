import { workspaceRoot } from '@nx/devkit';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { unstable_readConfig } from 'wrangler';

/**
 * Guards on the committed Worker configuration (architect note and threat models on #6, #8, #12):
 * no secret names, no owner email, no local-only flags in any `env.*` block, and the hooks Worker never
 * gets the GitHub token. Wrangler's own reader validates the files, so config drift fails here first.
 */

const ENVIRONMENTS = ['dev', 'stage', 'production'] as const;
type DeployEnvironment = (typeof ENVIRONMENTS)[number];

const SECRET_NAMES = ['GITHUB_TOKEN', 'WEBHOOK_SECRET', 'VAPID_PRIVATE_KEY', 'ROUTINE_TOKEN'] as const;
const LOCAL_ONLY_VARS = ['AUTH_MODE', 'GITHUB_MOCK'] as const;

interface WranglerEnvConfig {
  readonly name: string;
  readonly main: string;
  readonly compatibility_date: string;
  readonly vars: Readonly<Record<string, unknown>>;
  readonly d1_databases: readonly { binding: string; database_name: string; migrations_dir?: string }[];
  readonly assets?: {
    binding?: string;
    not_found_handling?: string;
    run_worker_first?: readonly string[] | boolean;
  };
}

function isWranglerEnvConfig(value: unknown): value is WranglerEnvConfig {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const config = value as Record<string, unknown>;
  return (
    typeof config['name'] === 'string' &&
    typeof config['main'] === 'string' &&
    typeof config['compatibility_date'] === 'string' &&
    typeof config['vars'] === 'object' &&
    config['vars'] !== null &&
    Array.isArray(config['d1_databases'])
  );
}

function readWorkerConfig(app: 'api' | 'hooks', env: DeployEnvironment): WranglerEnvConfig {
  const config: unknown = unstable_readConfig(
    { config: join(workspaceRoot, 'apps', app, 'wrangler.jsonc'), env },
    { hideWarnings: true },
  );
  if (!isWranglerEnvConfig(config)) {
    throw new Error(`wrangler returned an unexpected config shape for apps/${app} env ${env}`);
  }
  return config;
}

function readText(relativePath: string): string {
  return readFileSync(join(workspaceRoot, relativePath), 'utf8');
}

describe.each(['api', 'hooks'] as const)('apps/%s/wrangler.jsonc', (app) => {
  const expectedName = app === 'api' ? 'team-console' : 'team-console-hooks';

  it.each(ENVIRONMENTS)(
    'parses for env %s with the environment name, ENVIRONMENT var and the DB binding',
    (env) => {
      const config = readWorkerConfig(app, env);

      expect(config.name).toBe(`${expectedName}-${env}`);
      expect(config.vars['ENVIRONMENT']).toBe(env);
      expect(config.d1_databases).toEqual([
        expect.objectContaining({ binding: 'DB', database_name: `team-console-${env}` }),
      ]);
    },
  );

  it.each(ENVIRONMENTS)('has no secret in env %s vars', (env) => {
    const keys = Object.keys(readWorkerConfig(app, env).vars);
    for (const secret of SECRET_NAMES) {
      expect(
        keys.some((key) => key.startsWith(secret)),
        secret,
      ).toBe(false);
    }
  });

  it.each(ENVIRONMENTS)('has no local-only flag and never ENVIRONMENT=local in env %s', (env) => {
    const { vars } = readWorkerConfig(app, env);
    for (const flag of LOCAL_ONLY_VARS) {
      expect(vars, flag).not.toHaveProperty(flag);
    }
    expect(vars['ENVIRONMENT']).not.toBe('local');
  });

  it('names no secret and no e-mail address anywhere in the file, comments included', () => {
    const text = readText(`apps/${app}/wrangler.jsonc`);
    for (const secret of SECRET_NAMES) {
      expect(text, secret).not.toContain(secret);
    }
    expect(text).not.toMatch(/mailto:|[\w.+-]+@[\w-]+\.[\w.-]+/);
  });

  it('shares one compatibility date with the other Worker (one workerd for dev, Docker and tests)', () => {
    expect(readWorkerConfig(app, 'dev').compatibility_date).toBe('2026-08-15');
  });
});

describe('apps/api/wrangler.jsonc', () => {
  it.each(ENVIRONMENTS)('serves the SPA with the Worker first on /api/* in env %s', (env) => {
    expect(readWorkerConfig('api', env).assets).toEqual(
      expect.objectContaining({
        binding: 'ASSETS',
        not_found_handling: 'single-page-application',
        run_worker_first: ['/api/*'],
      }),
    );
  });

  it.each(ENVIRONMENTS)(
    'keeps OWNER_EMAIL, ACCESS_TEAM_DOMAIN and ACCESS_AUD empty in env %s (public repo)',
    (env) => {
      const { vars } = readWorkerConfig('api', env);
      expect(vars['OWNER_EMAIL']).toBe('');
      expect(vars['ACCESS_TEAM_DOMAIN']).toBe('');
      expect(vars['ACCESS_AUD']).toBe('');
    },
  );

  it('allows service tokens on dev and stage only', () => {
    expect(readWorkerConfig('api', 'dev').vars['ALLOW_SERVICE_TOKEN']).toBe('true');
    expect(readWorkerConfig('api', 'stage').vars['ALLOW_SERVICE_TOKEN']).toBe('true');
    expect(readWorkerConfig('api', 'production').vars['ALLOW_SERVICE_TOKEN']).toBe('false');
  });

  it.each(ENVIRONMENTS)('is the only Worker that applies migrations (env %s)', (env) => {
    expect(readWorkerConfig('api', env).d1_databases[0]?.migrations_dir).toBe('migrations');
    expect(readWorkerConfig('hooks', env).d1_databases[0]?.migrations_dir).toBeUndefined();
  });
});

describe('local auth bypass', () => {
  const requiredFlags = ['--var ENVIRONMENT:local', '--var AUTH_MODE:local'];

  it('is enabled by the Dockerfile with both flags on the wrangler dev command', () => {
    const devLine = readText('Dockerfile')
      .split('\n')
      .find((line) => line.startsWith('CMD') && line.includes('wrangler dev'));
    expect(devLine).toBeDefined();
    for (const flag of requiredFlags) {
      expect(devLine, flag).toContain(flag);
    }
  });

  it('is enabled by `nx serve api` with both flags', () => {
    const project = JSON.parse(readText('apps/api/project.json')) as {
      targets: { serve: { options: { command: string } } };
    };
    for (const flag of requiredFlags) {
      expect(project.targets.serve.options.command, flag).toContain(flag);
    }
  });
});
