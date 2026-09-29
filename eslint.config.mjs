import nx from '@nx/eslint-plugin';

/**
 * Feature-Sliced Design as Nx tags (ADR 0001, decision 2; architect note on #3).
 * Imports go strictly downward and a layer never imports its own layer, so
 * features never import features. `shared` is the only layer that may import itself.
 * A project whose tags match no constraint cannot import any project at all.
 */
export const layerConstraints = [
  {
    sourceTag: 'layer:app',
    onlyDependOnLibsWithTags: [
      'layer:pages',
      'layer:widgets',
      'layer:features',
      'layer:entities',
      'layer:shared',
    ],
  },
  {
    sourceTag: 'layer:pages',
    onlyDependOnLibsWithTags: ['layer:widgets', 'layer:features', 'layer:entities', 'layer:shared'],
  },
  {
    sourceTag: 'layer:widgets',
    onlyDependOnLibsWithTags: ['layer:features', 'layer:entities', 'layer:shared'],
  },
  { sourceTag: 'layer:features', onlyDependOnLibsWithTags: ['layer:entities', 'layer:shared'] },
  { sourceTag: 'layer:entities', onlyDependOnLibsWithTags: ['layer:shared'] },
  { sourceTag: 'layer:shared', onlyDependOnLibsWithTags: ['layer:shared'] },
];

export const scopeConstraints = [
  { sourceTag: 'scope:console', onlyDependOnLibsWithTags: ['scope:console', 'scope:shared'] },
  { sourceTag: 'scope:worker', onlyDependOnLibsWithTags: ['scope:worker', 'scope:shared'] },
  { sourceTag: 'scope:shared', onlyDependOnLibsWithTags: ['scope:shared'] },
  { sourceTag: 'scope:tooling', onlyDependOnLibsWithTags: ['scope:tooling'] },
];

export const moduleBoundaries = {
  enforceBuildableLibDependency: true,
  // Only workspace-root files, which the rule would otherwise treat as an external package:
  // per-project ESLint configs extend the root one, and the app reads its version from package.json.
  allow: ['^.*/eslint(\\.base)?\\.config\\.[cm]?[jt]s$', '^.*/package\\.json$'],
  depConstraints: [...layerConstraints, ...scopeConstraints],
};

export default [
  ...nx.configs['flat/base'],
  ...nx.configs['flat/typescript'],
  ...nx.configs['flat/javascript'],
  {
    ignores: [
      '**/dist',
      '**/out-tsc',
      '**/coverage',
      '**/.nx',
      '**/vitest.config.*.timestamp*',
      'docs/design/**',
    ],
  },
  {
    files: ['**/*.ts', '**/*.tsx', '**/*.js', '**/*.jsx', '**/*.mjs', '**/*.cjs', '**/*.mts', '**/*.cts'],
    rules: {
      '@nx/enforce-module-boundaries': ['error', moduleBoundaries],
    },
  },
];
