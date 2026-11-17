import type { Environment } from '@shared/contracts';
import {
  ENVIRONMENT_GROUPS,
  consoleRowsOf,
  projectRowsOf,
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

export interface GroupView {
  readonly group: EnvironmentGroup;
  /** The group's rows, missing first. */
  readonly rows: readonly RowView[];
}

/** The operator screen's tab (#750: the #104 screen without the `projects` group). */
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

/** A row counts toward the summary only when it is missing and the console needs it. */
export function isCountedMissing(view: RowView): boolean {
  return view.status === 'missing' && view.row.item.optional !== true;
}

export function environmentViewOf(input: EnvironmentViewInput): EnvironmentView {
  const all = consoleRowsOf(input.environment).map((row): RowView => ({ row, status: statusOf(row, input) }));
  const groups: GroupView[] = [];
  for (const group of ENVIRONMENT_GROUPS) {
    const inGroup = all.filter((view) => view.row.group === group);
    if (inGroup.length > 0) {
      groups.push({ group, rows: sorted(inGroup) });
    }
  }
  const ordered = groups.flatMap((group) => group.rows);
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

/** One environment's section of a project's screen (#750 UX spec §4). */
export interface ProjectSectionView {
  readonly environment: Environment;
  readonly isThisConsole: boolean;
  /** In manifest order; required rows are the only ones the summary counts. */
  readonly required: readonly RowView[];
  /** Each slot's token and routine together; never counted, never a warning. */
  readonly optional: readonly RowView[];
  readonly missing: number;
  readonly optionalMissing: number;
  readonly firstMissing: RowView | null;
}

export interface ProjectEnvironmentView {
  /** Only the environments that have rows for the project: this console's first, then dev → stage → production. */
  readonly sections: readonly ProjectSectionView[];
  /** The environments with nothing to set, for the one quiet line, in the same order. */
  readonly quiet: readonly Environment[];
  readonly rows: readonly RowView[];
}

export interface ProjectEnvironmentViewInput {
  readonly slug: string;
  readonly thisEnvironment: Environment | null;
  readonly snapshot: EnvironmentStatusDto | null;
}

/** The deployed environments in their order, then the owner's computer (the #104 tab order). */
const SECTION_ORDER: readonly Environment[] = ['dev', 'stage', 'production', 'local'];

export function projectEnvironmentViewOf(input: ProjectEnvironmentViewInput): ProjectEnvironmentView {
  const thisEnvironment = input.thisEnvironment;
  const order =
    thisEnvironment === null
      ? SECTION_ORDER
      : [thisEnvironment, ...SECTION_ORDER.filter((environment) => environment !== thisEnvironment)];
  const sections: ProjectSectionView[] = [];
  const quiet: Environment[] = [];
  for (const environment of order) {
    const context: EnvironmentViewInput = { environment, thisEnvironment, snapshot: input.snapshot };
    const rows = projectRowsOf(environment, input.slug).map((row): RowView => ({
      row,
      status: statusOf(row, context),
    }));
    if (rows.length === 0) {
      quiet.push(environment);
      continue;
    }
    const required = rows.filter((view) => view.row.item.optional !== true);
    const optional = rows.filter((view) => view.row.item.optional === true);
    sections.push({
      environment,
      isThisConsole: environment === thisEnvironment,
      required,
      optional,
      missing: required.filter(isCountedMissing).length,
      optionalMissing: optional.filter((view) => view.status === 'missing').length,
      firstMissing: required.find(isCountedMissing) ?? null,
    });
  }
  return {
    sections,
    quiet: SECTION_ORDER.filter((environment) => quiet.includes(environment)),
    rows: sections.flatMap((section) => [...section.required, ...section.optional]),
  };
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
