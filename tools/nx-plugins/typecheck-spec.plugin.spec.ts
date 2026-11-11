import type { CreateNodesContext, CreateNodesResult } from '@nx/devkit';
import { createNodesV2 } from './typecheck-spec.plugin.ts';

const [, createNodesFunction] = createNodesV2;

const context: CreateNodesContext = {
  workspaceRoot: '/repo',
  nxJsonConfiguration: {},
};

/** The plugin runs one `tsc` target per matched tsconfig.spec.json; helper narrows the lone result. */
async function createNodes(configFile: string): Promise<CreateNodesResult> {
  const results = await createNodesFunction([configFile], undefined, context);
  const entry = results[0];
  if (!entry) throw new Error(`createNodesV2 returned no result for ${configFile}`);
  return entry[1];
}

describe('typecheck-spec plugin createNodesV2', () => {
  it('declares one typecheck-spec target per tsconfig.spec.json, keyed by its project root', async () => {
    const result = await createNodes('tools/eslint-rules/tsconfig.spec.json');

    expect(Object.keys(result.projects ?? {})).toEqual(['tools/eslint-rules']);
  });

  it('quotes the tsconfig path instead of interpolating it unquoted into the shell command', async () => {
    const result = await createNodes('tools/eslint-rules/tsconfig.spec.json');

    const target = result.projects?.['tools/eslint-rules']?.targets?.['typecheck-spec'];
    expect(target?.command).toBe("tsc -p 'tools/eslint-rules/tsconfig.spec.json' --noEmit");
  });

  it('escapes single quotes already present in the path', async () => {
    const result = await createNodes("tools/it's-weird/tsconfig.spec.json");

    const target = result.projects?.["tools/it's-weird"]?.targets?.['typecheck-spec'];
    expect(target?.command).toBe(`tsc -p 'tools/it'\\''s-weird/tsconfig.spec.json' --noEmit`);
  });

  it('sets cwd explicitly to the workspace root', async () => {
    const result = await createNodes('tools/eslint-rules/tsconfig.spec.json');

    const target = result.projects?.['tools/eslint-rules']?.targets?.['typecheck-spec'];
    expect(target?.options).toEqual({ cwd: context.workspaceRoot });
  });

  it('mirrors the test target inputs (default, ^production, tsconfig.base.json, the tsconfig.spec.json itself)', async () => {
    const result = await createNodes('tools/eslint-rules/tsconfig.spec.json');

    const target = result.projects?.['tools/eslint-rules']?.targets?.['typecheck-spec'];
    expect(target?.inputs).toEqual([
      'default',
      '^production',
      '{workspaceRoot}/tsconfig.base.json',
      '{workspaceRoot}/tools/eslint-rules/tsconfig.spec.json',
    ]);
  });
});
