import type { Environment } from '@shared/contracts';
import {
  ENVIRONMENT_GROUPS,
  ENVIRONMENT_MANIFEST,
  environmentRowsOf,
  type EnvironmentGroup,
  type EnvironmentRow,
  type EnvironmentStatusDto,
  type ManifestItem,
} from '@shared/environment';

/**
 * What a row says (#104 UX spec §2): set or missing only when this console's own Worker reported it; "not visible
 * here" for everything that Worker cannot read, never guessed; `unknown` while the status is not there (loading,
 * failed, offline before the first answer) — the row then shows no status at all.
 */
export type RowStatus = 'set' | 'missing' | 'unseen' | 'unknown';

export interface RowView {
  readonly row: EnvironmentRow;
  readonly status: RowStatus;
}

export interface ProjectBlockView {
  readonly slug: string;
  readonly rows: readonly RowView[];
  readonly set: number;
  readonly total: number;
  readonly hasMissing: boolean;
}

export interface GroupView {
  readonly group: EnvironmentGroup;
  /** Every row but the per-project ones, sorted. */
  readonly rows: readonly RowView[];
  /** The `projects` group only: one block per project. */
  readonly projects: readonly ProjectBlockView[];
}

export interface EnvironmentView {
  readonly environment: Environment;
  readonly isThisConsole: boolean;
  readonly groups: readonly GroupView[];
  /** Missing rows that are not optional: the summary's count. */
  readonly missing: number;
  /** Rows only `setup --check` can see. */
  readonly unseen: number;
  readonly firstMissing: RowView | null;
  readonly rows: readonly RowView[];
}

export interface EnvironmentViewInput {
  readonly environment: Environment;
  /** This console's environment, or null while it is not known. */
  readonly thisEnvironment: Environment | null;
  readonly projectSlugs: readonly string[];
  readonly snapshot: EnvironmentStatusDto | null;
}

// Missing first, then what only setup can check, then the rest in manifest order (UX spec §2).
const RANK: Readonly<Record<RowStatus, number>> = { missing: 0, unseen: 1, set: 2, unknown: 2 };

function statusOf(row: EnvironmentRow, input: EnvironmentViewInput): RowStatus {
  const isThis = input.thisEnvironment === input.environment;
  if (row.binding === null || (input.thisEnvironment !== null && !isThis)) {
    return 'unseen';
  }
  const snapshot = input.snapshot;
  if (snapshot === null || snapshot.environment !== input.environment) {
    return 'unknown';
  }
  return snapshot.items.find((item) => item.id === row.id)?.status ?? 'unknown';
}

function sorted(rows: readonly RowView[]): RowView[] {
  return rows
    .map((view, index) => ({ view, index }))
    .sort((a, b) => RANK[a.view.status] - RANK[b.view.status] || a.index - b.index)
    .map(({ view }) => view);
}

function hasProjectItems(environment: Environment): boolean {
  return ENVIRONMENT_MANIFEST.items.some(
    (item) => item.pattern === true && item.environments.includes(environment),
  );
}

/** A row counts toward the summary only when it is missing and the console needs it. */
export function isCountedMissing(view: RowView): boolean {
  return view.status === 'missing' && view.row.item.optional !== true;
}

export function environmentViewOf(input: EnvironmentViewInput): EnvironmentView {
  const all = environmentRowsOf(input.environment, input.projectSlugs).map((row): RowView => ({
    row,
    status: statusOf(row, input),
  }));
  const groups: GroupView[] = [];
  for (const group of ENVIRONMENT_GROUPS) {
    const inGroup = all.filter((view) => view.row.group === group);
    if (group === 'projects') {
      if (!hasProjectItems(input.environment)) {
        continue;
      }
      const slugs = [...new Set(inGroup.map((view) => view.row.project ?? ''))].filter((slug) => slug !== '');
      groups.push({
        group,
        rows: [],
        projects: slugs.map((slug) => {
          const rows = sorted(inGroup.filter((view) => view.row.project === slug));
          return {
            slug,
            rows,
            set: rows.filter((view) => view.status === 'set').length,
            total: rows.length,
            hasMissing: rows.some((view) => view.status === 'missing'),
          };
        }),
      });
    } else if (inGroup.length > 0) {
      groups.push({ group, rows: sorted(inGroup), projects: [] });
    }
  }
  const ordered = groups.flatMap((group) => [
    ...group.rows,
    ...group.projects.flatMap((block) => block.rows),
  ]);
  return {
    environment: input.environment,
    isThisConsole: input.thisEnvironment === input.environment,
    groups,
    missing: ordered.filter(isCountedMissing).length,
    unseen: ordered.filter((view) => view.status === 'unseen').length,
    firstMissing: ordered.find(isCountedMissing) ?? null,
    rows: ordered,
  };
}

/** The project slugs a status answer covers (`project/<slug>/<NAME>` ids). */
export function projectSlugsOf(snapshot: EnvironmentStatusDto | null): string[] {
  const slugs = new Set<string>();
  for (const item of snapshot?.items ?? []) {
    const [place, slug] = item.id.split('/');
    if (place === 'project' && slug !== undefined) {
      slugs.add(slug);
    }
  }
  return [...slugs];
}

/** Who provides the value, for the guide's meta line. */
export type GuideSource = 'owner' | 'generated' | 'app' | 'fixed';

export function guideSourceOf(item: ManifestItem): GuideSource {
  if (item.origin === 'owner') {
    return 'owner';
  }
  if (item.guide.obtain === null) {
    // A value committed in wrangler.jsonc, or a local --var flag: nothing to obtain.
    return 'fixed';
  }
  // The manifest names the script that makes the console's GitHub App (and puts its values in place).
  return item.guide.obtain.includes('create-apps.sh') ? 'app' : 'generated';
}

export interface ProseSegment {
  readonly text: string;
  readonly code: boolean;
}

/** Manifest prose with its `backtick` spans as code; plain text only, never markup. */
export function proseSegmentsOf(text: string): ProseSegment[] {
  return text
    .split('`')
    .map((part, index) => ({ text: part, code: index % 2 === 1 }))
    .filter((segment) => segment.text !== '');
}
