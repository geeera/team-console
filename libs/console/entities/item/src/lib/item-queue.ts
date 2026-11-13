import { DEFAULT_FREEZE_DAYS, type ItemSummaryDto, type TrackerSprintDto } from '@shared/contracts';
import type { TrackerRead } from './items.api';

/** "3rd of 6 in Approved": the item's place in its lane of its sprint (or the backlog). */
export interface QueuePosition {
  readonly position: number;
  readonly total: number;
}

/**
 * The lane is the queue the team reads (#409 §2.2): open items of the same sprint and status, in the board's order —
 * by number, as `statusColumnsOf` sorts a lane (#18), until the tracker keeps an explicit order. `null` for a closed
 * item, which is on no board.
 */
export function queuePositionOf(
  item: ItemSummaryDto,
  peers: readonly ItemSummaryDto[],
): QueuePosition | null {
  if (item.state === 'closed') {
    return null;
  }
  const lane = peers
    .filter(
      (peer) =>
        peer.state === 'open' &&
        peer.sprint === item.sprint &&
        peer.status === item.status &&
        peer.number !== item.number,
    )
    .map((peer) => peer.number);
  const numbers = [...lane, item.number].sort((a, b) => a - b);
  return { position: numbers.indexOf(item.number) + 1, total: numbers.length };
}

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
