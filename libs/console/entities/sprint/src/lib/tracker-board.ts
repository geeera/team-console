import {
  currentSprintOf,
  openSprintsOf,
  type ItemKind,
  type ItemSummaryDto,
  type TrackerSprintDto,
} from '@shared/contracts';
import { statusColumnsOf, type SprintBoard, type SprintIssue, type StatusColumn } from './sprint.model';

/** The kinds `sprint-metrics` counts as work, as the GitHub read model does (#18's done tile). */
const WORK_KINDS: ReadonlySet<ItemKind> = new Set<ItemKind>(['feature', 'bug', 'chore', 'finding']);

/** A tracker item as a board row: no GitHub link, an imported author marked as in #434's question cards. */
export function sprintIssueOf(item: ItemSummaryDto): SprintIssue {
  return {
    number: item.number,
    title: item.title,
    url: null,
    state: item.state,
    status: item.status,
    tier: item.tier ?? 'standard',
    kind: item.kind,
    authorTrusted: item.createdBy.kind !== 'import',
    request: null,
  };
}

/** The part of #18's board a console-tracker project reads from the tracker; pull requests and runs stay as they are. */
export type TrackerSprintPart = Pick<SprintBoard, 'milestone' | 'issues' | 'planned' | 'shipped' | 'carriedOver'>;

/** The current sprint and its items, open and closed (Done is a lane), counted as the GitHub read model counts. */
export function trackerSprintPartOf(
  sprint: TrackerSprintDto | null,
  items: readonly ItemSummaryDto[],
): TrackerSprintPart {
  if (sprint === null) {
    return { milestone: null, issues: [], planned: 0, shipped: 0, carriedOver: 0 };
  }
  const mine = items.filter((item) => item.sprint === sprint.number);
  const work = mine.filter((item) => WORK_KINDS.has(item.kind));
  return {
    milestone: { number: sprint.number, title: sprint.title, dueOn: sprint.dueOn, url: null },
    issues: mine.map(sprintIssueOf).sort((a, b) => a.number - b.number),
    planned: work.length,
    shipped: work.filter((item) => item.state === 'closed' && item.status === 'done').length,
    carriedOver: work.filter((item) => item.state === 'open').length,
  };
}

/** `next` is the earliest future sprint by demo date, `later` every one after it. */
export type BoardSectionKind = 'current' | 'next' | 'later' | 'backlog';

export interface BoardSection {
  readonly kind: BoardSectionKind;
  /** `null` for the backlog. */
  readonly sprint: TrackerSprintDto | null;
  /** Workflow order, unknown statuses after Done, No status last (#18's lanes). */
  readonly lanes: readonly StatusColumn[];
  readonly openCount: number;
}

export interface BoardSections {
  /** `null` without an open sprint. */
  readonly current: BoardSection | null;
  readonly future: readonly BoardSection[];
  readonly backlog: BoardSection;
}

/** One section from its own items (a folder loads only its own, #557); other sprints' items are left out. */
export function sectionOf(
  kind: BoardSectionKind,
  sprint: TrackerSprintDto | null,
  items: readonly ItemSummaryDto[],
): BoardSection {
  const mine = items.filter((item) => item.sprint === (sprint?.number ?? null));
  return {
    kind,
    sprint,
    lanes: statusColumnsOf(mine.map(sprintIssueOf)),
    openCount: mine.filter((item) => item.state === 'open').length,
  };
}

/** Demo date first; a sprint without one goes after those with one, then by number. */
function byDemo(a: TrackerSprintDto, b: TrackerSprintDto): number {
  if (a.dueOn !== b.dueOn) {
    return a.dueOn === null ? 1 : b.dueOn === null ? -1 : a.dueOn.localeCompare(b.dueOn);
  }
  return a.number - b.number;
}

/**
 * The board by sprint of a console-tracker project (#108, #409 §8): the current sprint, every open future sprint
 * and the backlog, from every item read to the last page. An item of a closed sprint is on none of them.
 */
export function boardSectionsOf(
  sprints: readonly TrackerSprintDto[],
  items: readonly ItemSummaryDto[],
): BoardSections {
  const current = currentSprintOf(sprints);
  const future = openSprintsOf(sprints)
    .filter((sprint) => sprint !== current)
    .sort(byDemo);
  return {
    current: current === null ? null : sectionOf('current', current, items),
    future: future.map((sprint, index) => sectionOf(index === 0 ? 'next' : 'later', sprint, items)),
    backlog: sectionOf('backlog', null, items),
  };
}
