import type { TrackerSprintDto } from './dto';

/** The open sprints, earliest first; the first is the current one (the plugin's `sprint current`). */
export function openSprintsOf(sprints: readonly TrackerSprintDto[]): TrackerSprintDto[] {
  return sprints.filter((sprint) => sprint.state === 'open').sort((a, b) => a.number - b.number);
}

/** The current sprint: the earliest open one, `null` without any. */
export function currentSprintOf(sprints: readonly TrackerSprintDto[]): TrackerSprintDto | null {
  return openSprintsOf(sprints)[0] ?? null;
}
