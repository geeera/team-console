import { ElementRef, Injectable, Injector } from '@angular/core';
import type { WritableSignal } from '@angular/core';
import { focusAfterRender } from '@console/shared/ui';
import type { FailedWrite } from '@console/entities/item';
import type { StatusColumn } from '@console/entities/sprint';
import type { ItemMove, MovableItem, MoveHandlers } from '@console/features/move-item';
import type { ItemDto, ItemSummaryDto } from '@shared/contracts';
import { Subject } from 'rxjs';

export type BoardMoveEvent =
  | { readonly kind: 'moved'; readonly move: ItemMove }
  /** The task took another place in its lane (#456); it stays in its section. */
  | { readonly kind: 'reordered'; readonly item: ItemDto }
  | { readonly kind: 'failed'; readonly failed: FailedWrite; readonly item: MovableItem };

/**
 * Moves made from any section of the board (#558), told to every section: the one the task left drops its row, the
 * one it joined adds it, the one a failed move belongs to shows the error. Root-provided because Undo runs from the
 * toast after the row (and its ⋯) is gone.
 */
@Injectable({ providedIn: 'root' })
export class BoardMoves {
  private readonly subject = new Subject<BoardMoveEvent>();
  readonly events = this.subject.asObservable();
  readonly handlers: MoveHandlers = {
    moved: (move) => this.subject.next({ kind: 'moved', move }),
    reordered: (item) => this.subject.next({ kind: 'reordered', item }),
    failed: (failed, item) => this.subject.next({ kind: 'failed', failed, item }),
  };
}

/**
 * A section's items after `moved` took the place the server answered (#456): its lane — the open items of the same
 * sprint and status, in the list's order — with it at `queue.position`; other lanes stay as they were. Without a
 * queue (closed meanwhile) the item is only refreshed in place.
 */
export function placedInLane(items: readonly ItemSummaryDto[], moved: ItemDto): ItemSummaryDto[] {
  const isPeer = (item: ItemSummaryDto): boolean =>
    item.number !== moved.number &&
    item.state === 'open' &&
    item.sprint === moved.sprint &&
    item.status === moved.status;
  if (moved.queue === null) {
    return items.map((item) => (item.number === moved.number ? moved : item));
  }
  const lane = items.filter(isPeer);
  lane.splice(Math.min(Math.max(moved.queue.position - 1, 0), lane.length), 0, moved);
  return [...items.filter((item) => !isPeer(item) && item.number !== moved.number), ...lane];
}

/**
 * Lanes with the tasks moved in during this visit at the end of theirs, in the order they came (#409 §2.2: a move
 * puts the task at the end of the target's queue); the rest keep their order.
 */
export function arrivalsLast(lanes: readonly StatusColumn[], arrivals: readonly number[]): StatusColumn[] {
  if (arrivals.length === 0) {
    return [...lanes];
  }
  const rank = new Map(arrivals.map((number, index) => [number, index] as const));
  return lanes.map((lane) => ({
    status: lane.status,
    issues: [
      ...lane.issues.filter((issue) => !rank.has(issue.number)),
      ...lane.issues
        .filter((issue) => rank.has(issue.number))
        .sort((a, b) => (rank.get(a.number) ?? 0) - (rank.get(b.number) ?? 0)),
    ],
  }));
}

/** The ⋯ of a row, as `BoardMoveButton` renders it. */
export function moveButtonOf(root: HTMLElement, number: number): HTMLElement | null {
  return root.querySelector<HTMLElement>(`[data-move="${String(number)}"]`);
}

/**
 * Where focus goes once the row of `number` leaves (#558), read before it does: the ⋯ of the row that takes its
 * place, else of the one before it, else the lane's heading, else `fallback` (the lane, or the whole list, can go
 * with its last row).
 */
export function focusAfterLeaving(
  root: HTMLElement,
  number: number,
  fallback: () => HTMLElement | null,
): () => HTMLElement | null {
  const row = root.querySelector<HTMLElement>(`tc-list-row[data-number="${String(number)}"]`);
  const numberOf = (element: Element | null | undefined): number | null =>
    element instanceof HTMLElement && element.dataset['number'] !== undefined
      ? Number(element.dataset['number'])
      : null;
  const neighbour = numberOf(row?.nextElementSibling) ?? numberOf(row?.previousElementSibling);
  const status = row?.closest<HTMLElement>('tc-lane')?.dataset['status'];
  return () => {
    const button = neighbour === null ? null : moveButtonOf(root, neighbour);
    if (button !== null) {
      return button;
    }
    const lane = [...root.querySelectorAll<HTMLElement>('tc-lane')].find(
      (element) => element.dataset['status'] === status,
    );
    const landing = lane?.querySelector<HTMLElement>('[role="heading"]') ?? fallback();
    // A heading is not a tab stop; it takes focus once, as a landing point.
    if (landing !== null && !landing.hasAttribute('tabindex')) {
      landing.tabIndex = -1;
    }
    return landing;
  };
}

/** For `focusAfterRender`, which takes a ref. */
export function elementRefOf(element: HTMLElement | null): ElementRef<HTMLElement> | null {
  return element === null ? null : new ElementRef(element);
}

/** Whether a move touched this section's sprint at all — the task left it, joined it, or both are elsewhere. */
export function movesSection(move: ItemMove, section: number | null): boolean {
  return move.from === section || move.to === section;
}

/** Where a section reads and moves focus from, to apply `moved` (#558) without it owning the DOM lookups itself. */
export interface MoveFocusContext {
  readonly root: HTMLElement;
  readonly injector: Injector;
  /** Where focus lands if the row leaving has no neighbour and its lane has no heading (folder: the heading; board: the title). */
  readonly fallback: () => HTMLElement | null;
  readonly arrivals: WritableSignal<readonly number[]>;
}

/**
 * A section's items after `moved` (#558): the task's row dropped if it left, added at the end of its lane if it
 * joined (tracked in `arrivals` unless it is an Undo, which instead returns focus to the ⋯ it came from). Leaving
 * moves focus off the row before it is gone. Callers guard with `movesSection` first, since they also need that to
 * decide whether to reset their own `moveFailure`.
 */
export function itemsAfterMove(
  move: ItemMove,
  section: number | null,
  items: readonly ItemSummaryDto[],
  focus: MoveFocusContext,
): readonly ItemSummaryDto[] {
  const number = move.item.number;
  const others = items.filter((item) => item.number !== number);
  const next = move.to === section ? [...others, move.item] : others;
  if (move.from === section && !move.isUndo) {
    const target = focusAfterLeaving(focus.root, number, focus.fallback);
    focusAfterRender(() => elementRefOf(target()), { injector: focus.injector });
  }
  if (move.to === section) {
    if (move.isUndo) {
      focusAfterRender(() => elementRefOf(moveButtonOf(focus.root, number)), { injector: focus.injector });
    } else {
      focus.arrivals.update((arrivals) => [...arrivals.filter((n) => n !== number), number]);
    }
  }
  return next;
}
