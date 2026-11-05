import type { ItemSummaryDto, TrackerSprintDto } from '@shared/contracts';

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

/** The open sprints, earliest first; the first is the current one (the plugin's `sprint current`). */
export function openSprintsOf(sprints: readonly TrackerSprintDto[]): TrackerSprintDto[] {
  return sprints.filter((sprint) => sprint.state === 'open').sort((a, b) => a.number - b.number);
}

/** The current sprint: the earliest open one, `null` without any. */
export function currentSprintOf(sprints: readonly TrackerSprintDto[]): TrackerSprintDto | null {
  return openSprintsOf(sprints)[0] ?? null;
}
