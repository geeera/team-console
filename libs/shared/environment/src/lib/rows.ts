import { TEAM_SLOTS, type Environment } from '@shared/contracts';
import type { ManifestItem } from './manifest';
import { ENVIRONMENT_MANIFEST } from './manifest.generated';

/**
 * Where an item lives, in the order the Environment setup screen lists them (#104 UX spec §2): the groups this
 * console can check come first. Also the `:place` segment of a guide's URL (`project` + slug for per-project rows).
 */
export const ENVIRONMENT_GROUPS = [
  'api',
  'github-vars',
  'projects',
  'hooks',
  'github-secrets',
  'repo',
  'local',
] as const;

export type EnvironmentGroup = (typeof ENVIRONMENT_GROUPS)[number];

/** One line of the screen: a manifest item in one place, a pattern expanded with a real project slug. */
export interface EnvironmentRow {
  /** The guide's URL below `/settings/environment/:env/`: `api/OWNER_EMAIL`, `project/storify/ROUTINE_TOKEN_STORIFY`. */
  readonly id: string;
  readonly group: EnvironmentGroup;
  /** The real name, placeholders filled. */
  readonly name: string;
  readonly item: ManifestItem;
  /** The project slug of a per-project row. */
  readonly project: string | null;
  /**
   * The binding this environment's own api Worker reads for the row, or null when that Worker cannot see it (the
   * hooks Worker, GitHub secrets, a GitHub variable that never reaches the Worker).
   */
  readonly binding: string | null;
}

const SLUG_TOKEN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

function slugPart(slug: string): string {
  return slug.toUpperCase().replace(/-/g, '_');
}

/** The names a pattern stands for in one project; `<SLOT>` is every team slot (#114). */
export function expandPattern(pattern: string, slug: string): string[] {
  const named = pattern.replace('<SLUG>', slugPart(slug));
  return named.includes('<SLOT>')
    ? TEAM_SLOTS.map((slot) => named.replace('<SLOT>', slot.toUpperCase()))
    : [named];
}

/**
 * GitHub variables that reach the api Worker under another name, read from deploy.yml's `--var NAME:${{ vars.X }}`
 * as the manifest quotes it, so the mapping has no second copy.
 */
function workerAliases(items: readonly ManifestItem[]): ReadonlyMap<string, string> {
  const aliases = new Map<string, string>();
  for (const item of items) {
    for (const match of (item.guide.obtain ?? '').matchAll(
      /--var ([A-Z][A-Z0-9_]*):\$\{\{ vars\.([A-Z][A-Z0-9_]*) \}\}/g,
    )) {
      const [, binding, variable] = match;
      if (binding !== undefined && variable !== undefined) {
        aliases.set(variable, binding);
      }
    }
  }
  return aliases;
}

function isOnWorker(item: ManifestItem, app: 'api' | 'hooks'): boolean {
  return item.locations.some(
    (location) =>
      (location.place === 'wrangler-secret' || location.place === 'wrangler-var') && location.app === app,
  );
}

function hasPlace(item: ManifestItem, place: ManifestItem['locations'][number]['place']): boolean {
  return item.locations.some((location) => location.place === place);
}

/** The groups one item shows in, each once, in screen order. */
function groupsOf(item: ManifestItem): EnvironmentGroup[] {
  const groups = new Set<EnvironmentGroup>();
  if (item.pattern === true) {
    groups.add('projects');
  } else if (hasPlace(item, 'github-environment-variable')) {
    // A GitHub variable deploy.yml passes as `--var`: one row, checked on the Worker it reached.
    groups.add('github-vars');
  } else if (isOnWorker(item, 'api')) {
    groups.add('api');
  }
  if (isOnWorker(item, 'hooks')) {
    groups.add('hooks');
  }
  if (hasPlace(item, 'github-environment-secret')) {
    groups.add('github-secrets');
  }
  if (hasPlace(item, 'github-repository-secret')) {
    groups.add('repo');
  }
  if (hasPlace(item, 'local-only')) {
    groups.add('local');
  }
  return ENVIRONMENT_GROUPS.filter((group) => groups.has(group));
}

function bindingOf(
  item: ManifestItem,
  group: EnvironmentGroup,
  name: string,
  aliases: ReadonlyMap<string, string>,
): string | null {
  switch (group) {
    case 'api':
    case 'projects':
      return name;
    case 'github-vars':
      return isOnWorker(item, 'api') ? name : (aliases.get(name) ?? null);
    case 'local':
      // Local-only items are `--var` flags of the local api Worker itself (`nx serve api`, the Dockerfile).
      return item.neededBy.some((need) => need.includes('apps/api')) ? name : null;
    default:
      return null;
  }
}

/**
 * Every row of `environment`, in screen group order and manifest order inside a group; per-project patterns are
 * expanded for each slug given (registered, non-archived projects). Slugs that are not slug-shaped are skipped.
 */
export function environmentRowsOf(
  environment: Environment,
  projectSlugs: readonly string[],
  items: readonly ManifestItem[] = ENVIRONMENT_MANIFEST.items,
): EnvironmentRow[] {
  const aliases = workerAliases(items);
  const slugs = projectSlugs.filter((slug) => SLUG_TOKEN.test(slug));
  const rows: EnvironmentRow[] = [];
  for (const group of ENVIRONMENT_GROUPS) {
    for (const item of items) {
      if (!item.environments.includes(environment) || !groupsOf(item).includes(group)) {
        continue;
      }
      if (group === 'projects') {
        for (const slug of slugs) {
          for (const name of expandPattern(item.name, slug)) {
            rows.push({ id: `project/${slug}/${name}`, group, name, item, project: slug, binding: name });
          }
        }
        continue;
      }
      rows.push({
        id: `${group}/${item.name}`,
        group,
        name: item.name,
        item,
        project: null,
        binding: bindingOf(item, group, item.name, aliases),
      });
    }
  }
  return rows;
}
