import { workspaceRoot } from '@nx/devkit';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Regression guard for the Storybook publishing step in `.github/workflows/deploy.yml` (#25): PR #75 shipped
 * the design kit as the Nx project `console-shared-ui`, but the deploy workflow kept checking for a project
 * named `ui` and reading its build output from `dist/storybook/ui` — so the step always SKIPped, silently,
 * on every dev deploy. `.product-team/project.yml`'s `commands.storybook` already names the project
 * correctly; this test keeps the workflow from drifting away from it again.
 */

function readWorkflow(): string {
  return readFileSync(join(workspaceRoot, '.github/workflows/deploy.yml'), 'utf8');
}

describe('deploy.yml Storybook step', () => {
  it('checks for, builds and deploys the console-shared-ui Nx project, not the stale `ui` name', () => {
    const workflow = readWorkflow();
    expect(workflow).toContain('grep -qx console-shared-ui');
    expect(workflow).toContain('npx nx build-storybook console-shared-ui');
    expect(workflow).toContain('pages deploy dist/storybook/console-shared-ui');
    // The bare `ui` project name never shipped with this design kit (#13/#75 named it console-shared-ui) and
    // must not come back as the argument to any of the three Storybook commands above.
    expect(workflow).not.toMatch(/grep -qx ui\b/);
    expect(workflow).not.toMatch(/build-storybook ui\b/);
    expect(workflow).not.toMatch(/dist\/storybook\/ui\b/);
  });

  /**
   * Regression guard for #182: PR #175 turned the dev-only Storybook steps on for the first time, and they
   * ran between the Worker deploys and both smoke checks — a Storybook failure (missing Pages project,
   * missing Cloudflare Pages permission, a broken build) stopped the job there with `if: success()`, so the
   * api/hooks Workers that had just gone live on dev were never smoke-checked. The three Storybook steps
   * must stay after both smoke checks, and none of them may opt out of failing the job.
   */
  it('runs both smoke checks before the Storybook steps, none of which use continue-on-error', () => {
    const workflow = readWorkflow();
    expect(workflow).not.toMatch(/continue-on-error:/);

    const indexOf = (needle: string): number => {
      const index = workflow.indexOf(needle);
      expect(index).toBeGreaterThan(-1);
      return index;
    };

    const appSmokeCheck = indexOf('Smoke check — app Worker requires Access or fails closed');
    const hooksSmokeCheck = indexOf('Smoke check — hooks Worker is reachable');
    const storybookCheck = indexOf('Check Storybook project exists');
    const storybookBuild = indexOf('Build Storybook');
    const storybookDeploy = indexOf('Deploy Storybook');

    expect(appSmokeCheck).toBeLessThan(hooksSmokeCheck);
    expect(hooksSmokeCheck).toBeLessThan(storybookCheck);
    expect(storybookCheck).toBeLessThan(storybookBuild);
    expect(storybookBuild).toBeLessThan(storybookDeploy);
  });
});
