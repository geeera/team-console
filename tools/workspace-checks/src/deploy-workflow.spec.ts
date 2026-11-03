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
});
