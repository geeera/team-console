import { workspaceRoot } from '@nx/devkit';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * The console's CSP allows no inline script (#118, apps/console/public/_headers; the headers themselves are asserted
 * in apps/api/src/security-headers.spec.ts). Angular's critical-CSS inlining adds an inline script that swaps the
 * stylesheet in, which the policy would block and leave the app unstyled.
 */

function propertyAt(value: unknown, path: readonly string[]): unknown {
  let current = value;
  for (const key of path) {
    if (typeof current !== 'object' || current === null || !(key in current)) {
      return undefined;
    }
    current = (current as Record<string, unknown>)[key];
  }
  return current;
}

describe('console build vs. the CSP', () => {
  it('turns critical-CSS inlining off in the production build', () => {
    const project: unknown = JSON.parse(
      readFileSync(join(workspaceRoot, 'apps/console/project.json'), 'utf8'),
    );
    const path = [
      'targets',
      'build',
      'configurations',
      'production',
      'optimization',
      'styles',
      'inlineCritical',
    ];

    expect(propertyAt(project, path)).toBe(false);
  });
});
