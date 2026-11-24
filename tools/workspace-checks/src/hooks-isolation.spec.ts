import { workspaceRoot } from '@nx/devkit';
import { ESLint } from 'eslint';
import { join } from 'node:path';
import { reachableFrom } from './support/import-graph';

/**
 * Threat model C6 (#481): the hooks Worker holds no GitHub App credentials, so no module of its bundle may come from
 * `@worker/github` (the app's JWT signing, token minting, the client that carries a token). Since #479 the
 * `@worker/vcs-github` barrel re-exports the adapter and with it `@worker/github`; tree-shaking would probably drop
 * it, but nothing enforced that. Two guards: the hooks ESLint config refuses those imports, and this walk follows
 * every import the Worker's entry reaches, so a library the hooks Worker imports cannot pull it in either.
 */

const APP_AUTH_ROOT = 'libs/worker/github/';

async function lintHooksImport(specifier: string): Promise<string[]> {
  const eslint = new ESLint({
    cwd: workspaceRoot,
    overrideConfigFile: join(workspaceRoot, 'apps/hooks/eslint.config.mjs'),
  });
  const [result] = await eslint.lintText(`export { x } from '${specifier}';\n`, {
    filePath: join(workspaceRoot, 'apps/hooks/src/routes/isolation-probe.ts'),
  });
  return (result?.messages ?? [])
    .filter((message) => message.ruleId === 'no-restricted-imports')
    .map((message) => message.message);
}

describe('hooks Worker bundle isolation (threat model C6, #481)', () => {
  it('reaches no module of @worker/github from the Worker entry', () => {
    const reached = reachableFrom('apps/hooks/src/main.ts');
    const appAuth = [...reached.keys()].filter((file) => file.startsWith(APP_AUTH_ROOT));
    expect(
      appAuth.map((file) => `${file} (imported by ${reached.get(file) ?? '?'})`),
      'the hooks bundle must not contain the app auth',
    ).toEqual([]);
    // The walk does reach the webhook half, so an empty result above is not an empty walk.
    expect(reached.has('libs/worker/vcs-github/src/lib/webhooks.ts')).toBe(true);
    expect(reached.has('libs/worker/vcs-github/src/lib/adapter.ts')).toBe(false);
  });

  it('keeps the webhooks entry point of @worker/vcs-github free of the adapter and the app auth', () => {
    const reached = [...reachableFrom('libs/worker/vcs-github/src/webhooks.ts').keys()];
    expect(
      reached.filter(
        (file) => file.startsWith(APP_AUTH_ROOT) || file === 'libs/worker/vcs-github/src/lib/adapter.ts',
      ),
    ).toEqual([]);
  });

  it('would catch the barrel: the full @worker/vcs-github entry does reach @worker/github', () => {
    const reached = [...reachableFrom('libs/worker/vcs-github/src/index.ts').keys()];
    expect(reached.some((file) => file.startsWith(APP_AUTH_ROOT))).toBe(true);
  });

  it.each(['@worker/github', '@worker/github/testing', '@worker/vcs-github'])(
    'refuses an import of %s in the hooks Worker (lint)',
    async (specifier) => {
      const messages = await lintHooksImport(specifier);
      expect(messages).toHaveLength(1);
      expect(messages[0]).toContain('threat model C6');
    },
  );

  it('lets the hooks Worker import @worker/vcs-github/webhooks', async () => {
    await expect(lintHooksImport('@worker/vcs-github/webhooks')).resolves.toEqual([]);
  });
});
