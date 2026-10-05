import { createProjectGraphAsync, workspaceRoot } from '@nx/devkit';
import { ESLint } from 'eslint';
import { join } from 'node:path';
import { layerConstraints, scopeConstraints } from '../../../eslint.config.mjs';

const RULE = '@nx/enforce-module-boundaries';

/**
 * Lints an in-memory file as if it lived inside `projectRoot`, with that
 * project's real ESLint config and the real Nx project graph. Nothing is
 * written to disk, so the workspace never carries a failing fixture.
 */
async function lintImport(projectRoot: string, importPath: string): Promise<ESLint.LintMessage[]> {
  const eslint = new ESLint({
    cwd: workspaceRoot,
    overrideConfigFile: join(projectRoot, 'eslint.config.mjs'),
  });
  const [result] = await eslint.lintText(`import '${importPath}';\n`, {
    filePath: join(workspaceRoot, projectRoot, 'src/lib/boundary-probe.ts'),
  });
  return (result?.messages ?? []).filter((message) => message.ruleId === RULE);
}

describe('module boundaries (real ESLint run against the real project graph)', () => {
  beforeAll(async () => {
    // The rule reads the cached graph; make sure one exists even outside `nx run-many`.
    await createProjectGraphAsync({ exitOnError: false, resetDaemonClient: true });
  });

  it('lets a page import an entity (downward)', async () => {
    await expect(lintImport('libs/console/pages/settings', '@console/entities/app-info')).resolves.toEqual(
      [],
    );
  });

  it('lets shared import shared', async () => {
    await expect(lintImport('libs/console/entities/app-info', '@console/shared/config')).resolves.toEqual([]);
  });

  it('fails when shared imports a page (upward)', async () => {
    // A shared lib the settings page does not depend on, so the upward rule fires rather than the cycle check.
    const messages = await lintImport('libs/console/shared/persisted-state', '@console/pages/settings');

    expect(messages).toHaveLength(1);
    expect(messages[0]?.severity).toBe(2);
    expect(messages[0]?.message).toContain(
      'A project tagged with "layer:shared" can only depend on libs tagged with',
    );
    expect(messages[0]?.message).toContain('"layer:shared"');
  });

  it('fails when shared imports an entity (upward)', async () => {
    const messages = await lintImport('libs/console/shared/api', '@console/entities/app-info');

    expect(messages).toHaveLength(1);
    expect(messages[0]?.message).toContain(
      'A project tagged with "layer:shared" can only depend on libs tagged with',
    );
  });

  it('fails when a lib imports the page that already depends on it (cycle)', async () => {
    const messages = await lintImport('libs/console/shared/ui', '@console/pages/settings');

    expect(messages).toHaveLength(1);
    expect(messages[0]?.severity).toBe(2);
    expect(messages[0]?.message).toContain(
      'Circular dependency between "console-shared-ui" and "console-pages-settings"',
    );
  });
});

describe('dependency constraints (the matrix from the architect note on #3)', () => {
  const layers = ['app', 'pages', 'widgets', 'features', 'entities', 'shared'] as const;
  const allowed = (layer: string): string[] =>
    layerConstraints.find((constraint) => constraint.sourceTag === `layer:${layer}`)
      ?.onlyDependOnLibsWithTags ?? [];

  it('lets every layer depend only on the layers below it', () => {
    layers.forEach((layer, index) => {
      const below = layers.slice(index + 1).map((lower) => `layer:${lower}`);
      expect(allowed(layer), layer).toEqual(below.length > 0 ? below : ['layer:shared']);
    });
  });

  it('forbids same-layer imports everywhere but shared, so features never import features', () => {
    for (const layer of layers) {
      const importsItself = allowed(layer).includes(`layer:${layer}`);
      expect(importsItself, layer).toBe(layer === 'shared');
    }
  });

  it('keeps console, worker and shared scopes apart', () => {
    const scope = (name: string): string[] =>
      scopeConstraints.find((constraint) => constraint.sourceTag === `scope:${name}`)
        ?.onlyDependOnLibsWithTags ?? [];

    expect(scope('console')).toEqual(['scope:console', 'scope:shared']);
    expect(scope('worker')).toEqual(['scope:worker', 'scope:shared']);
    expect(scope('shared')).toEqual(['scope:shared']);
  });

  it('has no wildcard fallback, so an untagged project cannot import anything', () => {
    const wildcard = [...layerConstraints, ...scopeConstraints].find(
      (constraint) => constraint.sourceTag === '*',
    );
    expect(wildcard).toBeUndefined();
  });
});
