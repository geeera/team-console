import { DEFAULT_FREEZE_DAYS, type TrackerSprintDto } from '@shared/contracts';
import type { TrackerRead } from './items.api';

/**
 * The freeze length the tracker screens compute with: the project's `sprint.freeze_days` as the Worker read it from
 * project.yml (#457), or the plugin's default when that read failed — the freeze is a hint there, never a refusal.
 */
export function freezeDaysOrDefault(read: TrackerRead<number>): number {
  return read.ok ? read.value : DEFAULT_FREEZE_DAYS;
}

/** Today as a calendar day (`YYYY-MM-DD`) on this device. */
export function calendarTodayOf(now: Date): string {
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${String(now.getFullYear())}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

/** The sprint a new one goes after (#409 §2.3: always after the latest): the highest number, open or closed. */
export function latestSprintOf(sprints: readonly TrackerSprintDto[]): TrackerSprintDto | null {
  return [...sprints].sort((a, b) => b.number - a.number)[0] ?? null;
}

/** "Sprint 06": the title the server gives the next sprint (`Sprint NN`, highest number + 1). */
export function nextSprintTitleOf(sprints: readonly TrackerSprintDto[]): string {
  const next = (latestSprintOf(sprints)?.number ?? 0) + 1;
  return `Sprint ${String(next).padStart(2, '0')}`;
}
