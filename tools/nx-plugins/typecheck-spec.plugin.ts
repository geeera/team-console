import type { CreateNodesV2 } from '@nx/devkit';
import { dirname } from 'node:path';

/**
 * Declares a `typecheck-spec` target on every project that has a `tsconfig.spec.json` (#491): `nx run-many -t
 * typecheck-spec` / `nx affected -t typecheck-spec` then type-checks spec files the same way `test` runs them,
 * so a new project with a tsconfig.spec.json is covered without touching CI or this plugin again.
 */
export const createNodesV2: CreateNodesV2 = [
  '**/tsconfig.spec.json',
  (configFiles) =>
    configFiles.map((configFile) => {
      const projectRoot = dirname(configFile);
      return [
        configFile,
        {
          projects: {
            [projectRoot]: {
              targets: {
                'typecheck-spec': {
                  command: `tsc -p ${configFile} --noEmit`,
                  cache: true,
                  // Mirrors `test`'s inputs (@nx/vitest): spec files are part of `default`, not `production`,
                  // so the tsconfig.spec.json itself and files it reaches must be inputs explicitly.
                  inputs: [
                    'default',
                    '^production',
                    '{workspaceRoot}/tsconfig.base.json',
                    `{workspaceRoot}/${configFile}`,
                  ],
                  outputs: [],
                  metadata: {
                    technologies: ['typescript'],
                    description: 'Type-checks the project’s spec files',
                  },
                },
              },
            },
          },
        },
      ];
    }),
];
