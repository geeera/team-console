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
const indexesOf = (predicate: (step: Step) => boolean): readonly number[] =>
  steps.flatMap((step, index) => (predicate(step) ? [index] : []));

const BROWSER_DIR = 'dist/apps/console/browser';
const PROJECT_JSON = 'apps/console/project.json';
const GUARD = 'tools/deploy-guard/check-built-at.js';

/** True when `run` is exactly `node <guard> <args>`: one plain command, no shell operator that could mask its exit. */
const isGuard = (step: Step, ...args: readonly string[]): boolean =>
  (step.run ?? '')
    .trim()
    .split(/[ \t]+/)
    .join(' ') === ['node', GUARD, ...args].join(' ');
const writesStamp = (step: Step): boolean => step.run?.includes('__TC_BUILT_AT__') === true;
const buildsConsole = (step: Step): boolean =>
  /\bnx\b[^\n]*\s-t\s+build\b/.test(step.run ?? '') && !/storybook/i.test(step.run ?? '');
/** A step that can publish or holds a credential: wrangler in any form, or anything handed a secret. */
const canShip = (step: Step): boolean =>
  step.uses?.startsWith('cloudflare/wrangler-action@') === true ||
  /\bwrangler\b/.test(step.run ?? '') ||
  JSON.stringify(step).includes('secrets.');

describe('deploy.yml console build-stamp check', () => {
  const stamps = indexesOf(writesStamp);
  const configChecks = indexesOf((step) => isGuard(step, 'config', PROJECT_JSON));
  const builds = indexesOf(buildsConsole);
  const bundleChecks = indexesOf((step) => isGuard(step, 'bundle', PROJECT_JSON, BROWSER_DIR));
  const shipping = indexesOf(canShip);

  // #973 (REVIEW on PR #962): the invariant, not the line layout. A step may be added or moved between these,
  // as long as the order holds, the stamp is written once and the console is built once (a second stamp or a
  // rebuild after its check would ship something the check never saw).
  it('stamps, checks the stamp, builds, checks the bundle, and only then ships', () => {
    expect(stamps).toHaveLength(1);
    expect(configChecks).toHaveLength(1);
    expect(builds).toHaveLength(1);
    expect(bundleChecks).toHaveLength(1);
    expect(shipping.length).toBeGreaterThan(0);

    const order = [stamps[0] ?? -1, configChecks[0] ?? -1, builds[0] ?? -1, bundleChecks[0] ?? -1];
    expect(order).toEqual([...new Set(order)].sort((a, b) => a - b));
    expect(Math.min(...shipping)).toBeGreaterThan(Math.max(...order));
  });

  it('names the guard script only in those two exact commands', () => {
    const naming = indexesOf((step) => JSON.stringify(step).includes('check-built-at'));
    expect(naming).toEqual([...configChecks, ...bundleChecks]);
  });

  it('runs both checks unconditionally, for every environment, and never lets them pass on failure', () => {
    for (const index of [...configChecks, ...bundleChecks]) {
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
