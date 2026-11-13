import { LiveAnnouncer } from '@angular/cdk/a11y';
import { inject, Injectable } from '@angular/core';
import {
  calendarTodayOf,
  freezeDaysOrDefault,
  ItemsApi,
  newIdempotencyKey,
  type FailedWrite,
} from '@console/entities/item';
import { localCalendarDayOf, pluralKeyOf, TranslocoService } from '@console/shared/i18n';
import { Menu, Toaster } from '@console/shared/ui';
import {
  openSprintsOf,
  type ItemDto,
  type ItemSummaryDto,
  type QueueMove,
  type QueuePositionDto,
  type TrackerSprintDto,
} from '@shared/contracts';
import { moveMenuOf, moveTargetOf, queueMoveOf, SPRINT_CAP, type MoveMenuCopy, type MoveTarget } from './move-menu';

/** What a move needs to know of a task: any tracker read of it will do (a board row, the task screen). */
export type MovableItem = Pick<ItemSummaryDto, 'key' | 'number' | 'title' | 'sprint' | 'status' | 'version'>;

/** A move the server applied: the task as it is now, and where it came from. */
export interface ItemMove {
  readonly item: ItemDto;
  readonly from: MoveTarget;
  readonly to: MoveTarget;
  readonly isUndo: boolean;
}

/**
 * Where the outcome of a move goes. These are called after the opener may be gone (the board row leaves its section,
 * Undo runs from the toast), so they must not belong to a component that a move destroys.
 */
export interface MoveHandlers {
  readonly moved: (move: ItemMove) => void;
  /** The task took another place in its lane (#456): `item.queue` is where it is now; it left no section. */
  readonly reordered: (item: ItemDto) => void;
  /** `item` is the task where it still is; `retry` repeats the same write with the same idempotency key. */
  readonly failed: (failed: FailedWrite, item: MovableItem) => void;
}

/**
 * The task's place in its lane, read off the open items as the tracker lists them — queue order (#456) — so the
 * menu knows what is already first or last. `null` when the task is not among them (closed meanwhile).
 */
export function queuePositionIn(open: readonly ItemSummaryDto[], item: MovableItem): QueuePositionDto | null {
  const lane = open.filter((entry) => entry.sprint === item.sprint && entry.status === item.status);
  const index = lane.findIndex((entry) => entry.number === item.number);
  return index === -1 ? null : { position: index + 1, total: lane.length };
}

/**
 * The Move menu and the move itself (#409 §2.2), shared by Sprint ▾ on the task screen and ⋯ on a board row (#558):
 * First / Up / Down in the task's lane (#456: `POST …/queue`, announced as "TC-408: 1 of 2 in Approved", no toast —
 * the row stays where the eye is), every open sprint and the backlog, a move that applies at once (`PATCH {sprint}`
 * with `If-Match` and an idempotency key, the status kept), then the toast "TC-408 → Sprint 04" with Undo for 10 s
 * (⌘Z / Ctrl+Z), which moves it back on the version the move produced. Focus is the caller's: only it knows what is
 * on screen after the move.
 */
@Injectable({ providedIn: 'root' })
export class ItemMover {
  private readonly api = inject(ItemsApi);
  private readonly menu = inject(Menu);
  private readonly toaster = inject(Toaster);
  private readonly transloco = inject(TranslocoService);
  private readonly announcer = inject(LiveAnnouncer);

  /** A seam for specs. */
  now: () => Date = () => new Date();

  /** Reads the sprints and counts, opens the menu at `anchor` and applies the pick; settles once nothing is pending. */
  async open(anchor: HTMLElement, slug: string, item: MovableItem, handlers: MoveHandlers): Promise<void> {
    const [sprints, open, freezeDays] = await Promise.all([
      this.api.sprints(slug),
      this.api.items(slug, { state: 'open' }),
      this.api.freezeDays(slug),
    ]);
    if (!sprints.ok || !open.ok) {
      handlers.failed(
        {
          failure: { kind: sprints.ok && open.ok ? 'unknown' : 'network', field: null, retryAfter: null },
          retry: () => this.open(anchor, slug, item, handlers),
        },
        item,
      );
      return;
    }
    const counts = new Map<number | null, number>();
    for (const entry of open.value) {
      counts.set(entry.sprint, (counts.get(entry.sprint) ?? 0) + 1);
    }
    const openSprints = openSprintsOf(sprints.value);
    const picked = await this.menu.open(
      anchor,
      moveMenuOf(
        {
          item,
          queue: queuePositionIn(open.value, item),
          sprints: openSprints,
          counts,
          today: calendarTodayOf(this.now()),
          freezeDays: freezeDaysOrDefault(freezeDays),
        },
        this.copy(item),
      ),
    );
    if (picked === null) {
      return;
    }
    const queueMove = queueMoveOf(picked);
    if (queueMove !== undefined) {
      await this.reorder(slug, item, queueMove, newIdempotencyKey(), handlers);
      return;
    }
    const target = moveTargetOf(picked);
    if (target === undefined || target === item.sprint) {
      return;
    }
    await this.move(slug, item, target, newIdempotencyKey(), openSprints, handlers, false);
  }

  private async reorder(
    slug: string,
    item: MovableItem,
    move: QueueMove,
    key: string,
    handlers: MoveHandlers,
  ): Promise<void> {
    const result = await this.api.reorder(slug, item.number, item.version, move, key);
    if (!result.ok) {
      handlers.failed({ failure: result.failure, retry: () => this.reorder(slug, item, move, key, handlers) }, item);
      return;
    }
    const moved = result.value;
    handlers.reordered(moved);
    if (moved.queue !== null) {
      void this.announcer.announce(
        this.t('plan.reordered', {
          key: moved.key,
          pos: moved.queue.position,
          total: moved.queue.total,
          lane: this.t(`board.status.${moved.status}`),
        }),
        'polite',
      );
    }
  }

  private async move(
    slug: string,
    item: MovableItem,
    to: MoveTarget,
    key: string,
    sprints: readonly TrackerSprintDto[],
    handlers: MoveHandlers,
    isUndo: boolean,
  ): Promise<void> {
    const result = await this.api.update(slug, item.number, item.version, { sprint: to }, key);
    if (!result.ok) {
      handlers.failed(
        { failure: result.failure, retry: () => this.move(slug, item, to, key, sprints, handlers, isUndo) },
        item,
      );
      return;
    }
    const moved = result.value;
    const from = item.sprint;
    handlers.moved({ item: moved, from, to, isUndo });
    const where = this.whereOf(to, sprints);
    if (isUndo) {
      const undone = this.t('plan.undone', { key: moved.key, where });
      this.toaster.show(undone);
      void this.announcer.announce(undone, 'polite');
      return;
    }
    this.toaster.offerUndo(this.t('plan.moved', { key: moved.key, where }), {
      label: this.t('plan.undo'),
      run: () => void this.move(slug, moved, from, newIdempotencyKey(), sprints, handlers, true),
    });
  }

  private whereOf(target: MoveTarget, sprints: readonly TrackerSprintDto[]): string {
    if (target === null) {
      return this.t('plan.backlog');
    }
    return sprints.find((sprint) => sprint.number === target)?.title ?? `Sprint ${String(target).padStart(2, '0')}`;
  }

  private copy(item: MovableItem): MoveMenuCopy {
    const lang = this.transloco.getActiveLang();
    const day = (sprint: TrackerSprintDto): string =>
      sprint.dueOn === null ? '' : localCalendarDayOf(sprint.dueOn, lang);
    const counted = (key: string, n: number, params: Record<string, unknown> = {}): string =>
      this.t(pluralKeyOf(key, lang, n), { n, ...params });
    return {
      label: this.t('plan.menuAria', { key: item.key }),
      title: this.t('plan.menuTitle', { key: item.key }),
      sprintsGroup: this.t('plan.sprints'),
      to: (sprint) => this.t('plan.to', { sprint: sprint.title }),
      toCurrent: (sprint) => this.t('plan.toCurrent', { sprint: sprint.title }),
      toBacklog: this.t('plan.toBacklog'),
      count: (n, sprint) =>
        sprint.dueOn === null ? counted('plan.backlogCount', n) : counted('plan.count', n, { date: day(sprint) }),
      backlogCount: (n) => counted('plan.backlogCount', n),
      full: (n) => counted('plan.full', n, { cap: SPRINT_CAP }),
      here: this.t('plan.here'),
      freeze: (sprint) => this.t('plan.freeze', { date: day(sprint) }),
      inProgress: this.t('plan.inProgressWarn'),
      queueGroup: this.t('plan.queueGroup', { lane: this.t(`board.status.${item.status}`) }),
      first: this.t('plan.first'),
      up: this.t('plan.up'),
      down: this.t('plan.down'),
      alreadyFirst: this.t('plan.alreadyFirst'),
      alreadyLast: this.t('plan.alreadyLast'),
    };
  }

  private t(key: string, params?: Record<string, unknown>): string {
    return this.transloco.translate(key, params);
  }
}
