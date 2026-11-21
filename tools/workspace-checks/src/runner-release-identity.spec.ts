import { workspaceRoot } from '@nx/devkit';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

/**
 * RR13 unchanged after the release identity moved to @shared/contracts (#634 PR 5): its constants stay compile-time.
 * The module imports nothing that could carry a runtime value and reads no environment, config or network; the
 * runner verifies a download with `attestationVerifyArgs(<file>, <version>)` and no identity flag of its own; and no
 * other runner source names the publisher, so nothing can point `update` elsewhere.
 */

const read = (path: string): string => readFileSync(join(workspaceRoot, path), 'utf8');
const IDENTITY = 'libs/shared/contracts/src/lib/runner-release.ts';

function sourcesUnder(dir: string): string[] {
  return readdirSync(join(workspaceRoot, dir), { recursive: true, encoding: 'utf8' })
    .filter((path) => path.endsWith('.ts') && !path.endsWith('.spec.ts'))
    .map((path) => join(dir, path));
}

describe('the runner release identity', () => {
  const source = read(IDENTITY);
  // The code alone: a comment may well mention `process.platform`.
  const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

  it('imports only the runner contract module and reads nothing at run time', () => {
    const imports = [...source.matchAll(/^import .* from '([^']+)';$/gm)].map((match) => match[1]);
    expect(imports).toEqual(['./runner']);
    for (const runtime of ['process', 'globalThis', 'fetch(', 'env', 'localStorage', 'readFile', 'require(']) {
      expect(code).not.toContain(runtime);
    }
    // Every identity member is a `const` with a literal: nothing assigned later, nothing computed from input.
    for (const name of ['RELEASE_HOST', 'RELEASE_REPOSITORY', 'RELEASE_WORKFLOW_PATH', 'RELEASE_OIDC_ISSUER', 'RELEASE_PREDICATE_TYPE']) {
      expect(source).toMatch(new RegExp(`^export const ${name} = '[^']+';$`, 'm'));
    }
  });

  it('is what the runner verifies with, given only the file and the version', () => {
    const update = read('apps/runner/src/update/update.ts');
    expect([...update.matchAll(/attestationVerifyArgs\(([^)]*)\)/g)].map((match) => match[1])).toEqual(['tarball, target']);
    expect(update).toMatch(/import \{[^}]*attestationVerifyArgs[^}]*\} from '@shared\/contracts';/);
  });

  it('is named nowhere else in the runner', () => {
    for (const path of sourcesUnder('apps/runner/src')) {
      const text = read(path);
      expect(text, path).not.toContain('geeera/team-console');
      expect(text, path).not.toContain('release-runner.yml');
    }
  });
});
