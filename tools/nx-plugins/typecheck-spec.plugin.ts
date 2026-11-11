import type { CreateNodesV2 } from '@nx/devkit';
import { dirname } from 'node:path';

/**
 * Quotes a path for safe interpolation into a shell command (POSIX single-quoting): a repo path with
 * shell metacharacters would otherwise break the command or inject into it (security review of #491).
 */
function quoteShellArg(path: string): string {
  return `'${path.replace(/'/g, `'\\''`)}'`;
}

/**
 * Declares a `typecheck-spec` target on every project that has a `tsconfig.spec.json` (#491): `nx run-many -t
 * typecheck-spec` / `nx affected -t typecheck-spec` then type-checks spec files the same way `test` runs them,
 * so a new project with a tsconfig.spec.json is covered without touching CI or this plugin again.
 */
export const createNodesV2: CreateNodesV2 = [
  '**/tsconfig.spec.json',
  (configFiles, _options, context) =>
    configFiles.map((configFile) => {
      const projectRoot = dirname(configFile);
      return [
        configFile,
        {
          projects: {
            [projectRoot]: {
              targets: {
                'typecheck-spec': {
                  command: `tsc -p ${quoteShellArg(configFile)} --noEmit`,
                  options: {
                    // Explicit: run-commands otherwise falls back to the invoking process's cwd.
                    cwd: context.workspaceRoot,
                  },
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
