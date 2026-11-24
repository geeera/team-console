import { workspaceRoot } from '@nx/devkit';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parse } from 'yaml';
import { DEPLOY_ENVIRONMENTS, readWorkerConfig } from './support/wrangler-config';

/**
 * #960: deploy.yml must refuse a console build whose `__TC_BUILT_AT__` stamp is missing, the "local" default or
 * malformed, since the «Обновлено» note goes silent otherwise. The script's own fixtures are
 * tools/deploy-guard/check-built-at.test.js; this keeps the workflow wired to it in the right order.
 */

interface Step {
  readonly name?: string;
  readonly run?: string;
  readonly uses?: string;
  readonly if?: string;
  readonly env?: Readonly<Record<string, unknown>>;
  readonly 'continue-on-error'?: unknown;
}

const deploy = parse(readFileSync(join(workspaceRoot, '.github/workflows/deploy.yml'), 'utf8')) as {
  readonly jobs: Readonly<Record<string, { readonly steps?: readonly Step[] }>>;
};
const steps = deploy.jobs['deploy']?.steps ?? [];
const indexOf = (predicate: (step: Step) => boolean): number => steps.findIndex(predicate);

const BROWSER_DIR = 'dist/apps/console/browser';

describe('deploy.yml console build-stamp check', () => {
  const stamp = indexOf((step) => step.run?.includes('__TC_BUILT_AT__') === true);
  const configCheck = indexOf((step) => step.run === 'node tools/deploy-guard/check-built-at.js config apps/console/project.json');
  const build = indexOf((step) => step.run?.startsWith('npx nx run-many -t build') === true);
  const bundleCheck = indexOf(
    (step) => step.run === `node tools/deploy-guard/check-built-at.js bundle apps/console/project.json ${BROWSER_DIR}`,
  );
  const firstWrangler = indexOf((step) => step.uses?.startsWith('cloudflare/wrangler-action@') === true);

  it('checks the stamp right after the stamp step and the bundle right after the build, before anything ships', () => {
    expect(stamp).toBeGreaterThanOrEqual(0);
    expect(configCheck).toBe(stamp + 1);
    expect(build).toBe(configCheck + 1);
    expect(bundleCheck).toBe(build + 1);
    expect(firstWrangler).toBeGreaterThan(bundleCheck);
  });

  it('runs both checks unconditionally, for every environment, and never lets them pass on failure', () => {
    for (const index of [configCheck, bundleCheck]) {
      expect(steps[index]?.if).toBeUndefined();
      expect(steps[index]?.['continue-on-error']).toBeUndefined();
      expect(steps[index]?.run).not.toContain('${{');
    }
  });

  it.each(DEPLOY_ENVIRONMENTS)('checks the directory the api Worker serves as assets in env %s', (env) => {
    const directory = readWorkerConfig('api', env).assets?.directory ?? '';
    expect(resolve(workspaceRoot, 'apps/api', directory)).toBe(resolve(workspaceRoot, BROWSER_DIR));
  });
});
