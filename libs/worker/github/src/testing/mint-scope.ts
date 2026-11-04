import { INSTALLATION_LIST_PERMISSIONS, INSTALLATION_PERMISSIONS } from '../lib/app-auth';

// Test-only: the mint answer of a scripted api.github.com, shared by this lib's and the api Worker's kits.

export const INSTALLATION_LOOKUP = /^\/repos\/([^/]+)\/([^/]+)\/installation$/;

/**
 * The owner of every repository looked up through `GET /repos/{owner}/{name}/installation`, by lower-cased name:
 * a mint body names repositories without their owner, while GitHub's answer lists them by `full_name` (#317).
 */
export function repositoryOwners(): {
  readonly record: (path: string) => void;
  readonly ownerOf: (name: string) => string | undefined;
} {
  const owners = new Map<string, string>();
  return {
    record: (path) => {
      const match = INSTALLATION_LOOKUP.exec(path);
      if (match?.[1] !== undefined && match[2] !== undefined) {
        owners.set(match[2].toLowerCase(), match[1]);
      }
    },
    ownerOf: (name) => owners.get(name.toLowerCase()),
  };
}

export interface MintScope {
  readonly permissions: Readonly<Record<string, 'read'>>;
  readonly repository_selection: 'selected' | 'all';
  readonly repositories?: readonly { readonly name: string; readonly full_name: string }[];
}

/**
 * The scope GitHub echoes for a mint body (#76, #317): a repository mint downscoped to `INSTALLATION_PERMISSIONS`
 * and `selected`, listing the requested repositories by `full_name` (owner from `ownerOf`); a mint naming no
 * repositories (the #194 list token) gets `INSTALLATION_LIST_PERMISSIONS` and the installation's own selection,
 * `all` here.
 */
export function mintScopeOf(
  body: string | undefined,
  ownerOf: (name: string) => string | undefined = () => undefined,
): MintScope {
  const request = JSON.parse(body ?? '{}') as Record<string, unknown>;
  const requested = request['repositories'];
  if (requested === undefined) {
    return { permissions: INSTALLATION_LIST_PERMISSIONS, repository_selection: 'all' };
  }
  const names = Array.isArray(requested) ? requested.filter((name) => typeof name === 'string') : [];
  return {
    permissions: INSTALLATION_PERMISSIONS,
    repository_selection: 'selected',
    repositories: names.map((name) => ({ name, full_name: `${ownerOf(name) ?? 'unknown-owner'}/${name}` })),
  };
}
