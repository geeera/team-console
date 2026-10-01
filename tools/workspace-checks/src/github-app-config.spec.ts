import { workspaceRoot } from '@nx/devkit';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { unstable_readConfig } from 'wrangler';

/**
 * ADR 0003 verification map, decisions 1 and 7 (#9): the PAT is gone from the api Worker, the api Worker
 * declares the console app's vars and secrets, the public hooks Worker holds no GitHub credential of any kind,
 * and deploy.yml hands the app's three vars to the api Worker of every environment.
 */

const ENVIRONMENTS = ['dev', 'stage', 'production'] as const;
const APP_VARS = ['GITHUB_APP_ID', 'GITHUB_APP_CLIENT_ID', 'OWNER_GITHUB_LOGIN'] as const;
const APP_SECRETS = ['GITHUB_APP_PRIVATE_KEY', 'GITHUB_APP_CLIENT_SECRET', 'TOKEN_ENCRYPTION_KEY'] as const;
const HOOKS_FORBIDDEN = /GITHUB_APP_|GITHUB_TOKEN|TOKEN_ENCRYPTION_KEY/;

function readText(relativePath: string): string {
  return readFileSync(join(workspaceRoot, relativePath), 'utf8');
}

function filesUnder(relativeDir: string): string[] {
  const root = join(workspaceRoot, relativeDir);
  const walk = (dir: string): string[] =>
    readdirSync(dir).flatMap((entry) => {
      const full = join(dir, entry);
      if (entry === 'node_modules' || entry === '.wrangler') {
        return [];
      }
      return statSync(full).isDirectory() ? walk(full) : [relative(workspaceRoot, full)];
    });
  return walk(root);
}

function apiVars(env: (typeof ENVIRONMENTS)[number]): Record<string, unknown> {
  const config = unstable_readConfig(
    { config: join(workspaceRoot, 'apps/api/wrangler.jsonc'), env },
    { hideWarnings: true },
  ) as { vars?: Record<string, unknown> };
  return config.vars ?? {};
}

/** The `- name: <title>` step of deploy.yml up to the next step. */
function deployStep(title: string): string {
  const lines = readText('.github/workflows/deploy.yml').split('\n');
  const start = lines.findIndex((line) => line.trim() === `- name: ${title}`);
  if (start < 0) {
    throw new Error(`deploy.yml has no step "${title}"`);
  }
  const end = lines.findIndex((line, index) => index > start && line.trim().startsWith('- name:'));
  return lines.slice(start, end < 0 ? undefined : end).join('\n');
}

describe('apps/api', () => {
  it('names no GITHUB_TOKEN in src/env.ts or wrangler.jsonc (the PAT is gone)', () => {
    expect(readText('apps/api/src/env.ts')).not.toContain('GITHUB_TOKEN');
    expect(readText('apps/api/wrangler.jsonc')).not.toContain('GITHUB_TOKEN');
  });

  it.each(APP_VARS)('declares the var %s as a required string in src/env.ts', (name) => {
    expect(readText('apps/api/src/env.ts')).toMatch(new RegExp(`readonly ${name}: string;`));
  });

  it.each(APP_SECRETS)('declares the secret %s as optional in src/env.ts', (name) => {
    expect(readText('apps/api/src/env.ts')).toMatch(new RegExp(`readonly ${name}\\?: string;`));
  });

  it.each(ENVIRONMENTS)('keeps the app vars empty in env %s (they come from deploy.yml)', (env) => {
    const vars = apiVars(env);
    for (const name of APP_VARS) {
      expect(vars[name], name).toBe('');
    }
    for (const name of APP_SECRETS) {
      expect(vars, name).not.toHaveProperty(name);
    }
  });
});

describe('apps/hooks (public, ADR 0003 decision 8)', () => {
  const files = filesUnder('apps/hooks');

  it('is scanned (the list is not vacuous)', () => {
    expect(files).toEqual(expect.arrayContaining(['apps/hooks/src/env.ts', 'apps/hooks/wrangler.jsonc']));
  });

  it.each(files)('%s references no GITHUB_APP_*, GITHUB_TOKEN or TOKEN_ENCRYPTION_KEY', (file) => {
    expect(readText(file)).not.toMatch(HOOKS_FORBIDDEN);
  });

  it('is deployed without any GitHub App var', () => {
    expect(deployStep('Deploy hooks Worker')).not.toMatch(HOOKS_FORBIDDEN);
  });

  it('is deployed with the VAPID public key from vars.VAPID_PUBLIC_KEY (#12 sends pushes)', () => {
    expect(deployStep('Deploy hooks Worker')).toContain(
      '--var VAPID_PUBLIC_KEY:${{ vars.VAPID_PUBLIC_KEY }}',
    );
  });
});

describe('.github/workflows/deploy.yml', () => {
  const step = deployStep('Deploy api Worker (app + assets)');

  it.each([
    ['GITHUB_APP_ID', 'CONSOLE_GITHUB_APP_ID'],
    ['GITHUB_APP_CLIENT_ID', 'CONSOLE_GITHUB_APP_CLIENT_ID'],
    ['OWNER_GITHUB_LOGIN', 'OWNER_GITHUB_LOGIN'],
    // #11: not an app var, but delivered the same way.
    ['VAPID_PUBLIC_KEY', 'VAPID_PUBLIC_KEY'],
  ])('passes %s to the api Worker from vars.%s', (binding, variable) => {
    expect(step).toContain(`--var ${binding}:\${{ vars.${variable} }}`);
  });

  it('deploys that step for the environment the run targets, so each environment gets its own values', () => {
    expect(step).toContain('deploy --env ${{ env.ENV_NAME }}');
    const workflow = readText('.github/workflows/deploy.yml');
    expect(workflow).toContain('name: ${{ needs.guard.outputs.env_name }}');
    expect(workflow).toContain('dev|stage|production) ;;');
  });
});
