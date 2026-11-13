import baseConfig from '../../eslint.config.mjs';

/**
 * ADR 0008 decision 1 (architect note on #468): the runner ships as one file with no runtime dependency, so its
 * sources import `node:*` and the two shared libs only. `bundle.spec.ts` proves it on the real bundle; this rule
 * stops the import at write time. Specs and the build script are tooling and may use dev dependencies.
 */
export const runnerRestrictedImports = {
  patterns: [
    {
      regex: '^(?!node:|@shared/contracts$|@shared/redaction$|\\.{1,2}/)',
      message:
        'The runner has no runtime dependencies (ADR 0008 decision 1): import node:* built-ins, @shared/contracts or @shared/redaction only.',
    },
  ],
};

export default [
  ...baseConfig,
  {
    files: ['**/*.ts'],
    ignores: ['**/*.spec.ts', '**/src/testing/**'],
    rules: {
      'no-restricted-imports': ['error', runnerRestrictedImports],
    },
  },
];
