import {
  ChangeDetectionStrategy,
  Component,
  computed,
  DestroyRef,
  effect,
  ElementRef,
  inject,
  Injector,
  input,
  model,
  signal,
  untracked,
  viewChild,
} from '@angular/core';
import { takeUntilDestroyed, toSignal } from '@angular/core/rxjs-interop';
import { ItemsApi, TrackerFailureBlock, type FailedWrite } from '@console/entities/item';
import {
  demoDayOf,
  sectionOf,
  SprintItemList,
  type BoardSection,
  type StatusColumn,
} from '@console/entities/sprint';
import {
  localDayOf,
  pluralKeyOf,
  localNumberOf,
  TranslocoPipe,
  TranslocoService,
} from '@console/shared/i18n';
import { Button, focusAfterRender, Lane, Lanes, StateBlock } from '@console/shared/ui';
import type { ItemMove } from '@console/features/move-item';
import type { ItemDto, ItemSummaryDto } from '@shared/contracts';
import { BoardMoveButton } from './board-move-button';
import { arrivalsLast, BoardMoves, elementRefOf, focusAfterLeaving, moveButtonOf, placedInLane } from './board-moves';
import { hiddenCountOf, laneNameOf, PREFERRED_LANES, visibleItemsOf } from './sprint-board';

/** Rows a folder lane adds per «Show 30 more» (#108 §2). */
export const FOLDER_LANE_PAGE = 30;

/** A folder as its header knows it before any item is read: the sprint (none for the backlog) and its open count. */
export type BoardFolderSpec = Pick<BoardSection, 'kind' | 'sprint' | 'openCount'>;

/** `idle` until first shown; a loaded folder keeps its rows while hidden (#557). */
export type BoardFolderState =
  | { readonly kind: 'idle' | 'loading' | 'error' | 'offline' }
  | { readonly kind: 'loaded'; readonly items: readonly ItemSummaryDto[] };

const SKELETON_ROWS = [0, 1, 2] as const;

let nextFolderId = 0;

/**
 * One collapsed folder under the current sprint (#108, #409 §8): its header reads the sprint list only; Show tasks
 * loads the folder's own open items, once per visit. Hidden content stays rendered (`hidden`), so Show again does not
 * reload and the phone keeps the folder's lane. Lanes are those with items, in workflow order.
 */
@Component({
  selector: 'tc-board-folder',
  imports: [BoardMoveButton, Button, Lane, Lanes, SprintItemList, StateBlock, TrackerFailureBlock, TranslocoPipe],
  templateUrl: './board-folder.html',
  styleUrl: './board-folder.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class BoardFolder {
  private readonly items = inject(ItemsApi);
  private readonly transloco = inject(TranslocoService);
  private readonly injector = inject(Injector);
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);

  readonly slug = input.required<string>();
  readonly folder = input.required<BoardFolderSpec>();
  /** Shown or collapsed; showing an unloaded folder loads it. */
  readonly open = model(false);

  readonly state = signal<BoardFolderState>({ kind: 'idle' });
  /** Tasks moved in during this visit, shown at the end of their lane (#558). */
  private readonly arrivals = signal<readonly number[]>([]);
  /** A move of one of this folder's tasks that did not happen (#558): the error block at the top. */
  protected readonly moveFailure = signal<FailedWrite | null>(null);
  protected readonly selectedLane = signal<string | null>(null);
  /** Rows shown per lane past the first `FOLDER_LANE_PAGE`. */
  private readonly shown = signal<ReadonlyMap<string, number>>(new Map());
  private loadToken = 0;

  private readonly id = nextFolderId++;
  protected readonly headingId = `tc-board-folder-${this.id}`;
  protected readonly bodyId = `tc-board-folder-body-${this.id}`;
  protected readonly skeletonRows = SKELETON_ROWS;
  protected readonly preferredLanes = PREFERRED_LANES;
  private readonly toggleButton = viewChild('toggleButton', { read: ElementRef<HTMLElement> });
  private readonly headingEl = viewChild('heading', { read: ElementRef<HTMLElement> });
  private readonly lang = toSignal(this.transloco.langChanges$, {
    initialValue: this.transloco.getActiveLang(),
  });

  protected readonly kicker = computed(() => `board.sections.${this.folder().kind}`);
  /** The folder in copy: the sprint's title, or «Backlog». */
  protected readonly name = computed(() => {
    this.lang();
    return this.folder().sprint?.title ?? this.transloco.translate('board.sections.backlog');
  });
  protected readonly demo = computed(() => {
    const dueOn = this.folder().sprint?.dueOn ?? null;
    return dueOn === null
      ? ''
      : this.transloco.translate('board.demo', { date: localDayOf(demoDayOf(dueOn), this.lang()) });
  });
  protected readonly openLine = computed(() => {
    const lang = this.lang();
    const n = this.folder().openCount;
    return this.transloco.translate(pluralKeyOf('board.sections.open', lang, n), { n: localNumberOf(n, lang) });
  });
  protected readonly lanes = computed(() => {
    const state = this.state();
    if (state.kind !== 'loaded') {
      return null;
    }
    const { kind, sprint } = this.folder();
    const lanes = sectionOf(kind, sprint, state.items).lanes.filter((lane) => lane.issues.length > 0);
    return arrivalsLast(lanes, this.arrivals());
  });
  /** The rows' tracker items by number, for their ⋯. */
  protected readonly movable = computed(() => {
    const state = this.state();
    return new Map(state.kind === 'loaded' ? state.items.map((item) => [item.number, item] as const) : []);
  });
  /** What the folder's polite live region says; errors speak through their own alert. */
  protected readonly announcement = computed(() => {
    this.lang();
    const section = this.name();
    switch (this.state().kind) {
      case 'loading':
        return this.transloco.translate('board.sections.loading', { section });
      case 'loaded':
        return this.transloco.translate('board.sections.loaded', { section, open: this.openLine() });
      default:
        return '';
    }
  });

  constructor() {
    effect(() => {
      if (this.open()) {
        untracked(() => {
          const kind = this.state().kind;
          if (kind !== 'loaded' && kind !== 'loading') {
            void this.load();
          }
        });
      }
    });
    inject(DestroyRef).onDestroy(() => {
      this.loadToken += 1;
    });
    inject(BoardMoves)
      .events.pipe(takeUntilDestroyed())
      .subscribe((event) => {
        if (event.kind === 'moved') {
          this.onMoved(event.move);
        } else if (event.kind === 'reordered') {
          this.onReordered(event.item);
        } else if (event.item.sprint === this.sprintNumber()) {
          this.moveFailure.set(event.failed);
        }
      });
  }

  protected async retryMove(): Promise<void> {
    const failed = this.moveFailure();
    if (failed !== null) {
      this.moveFailure.set(null);
      await failed.retry();
    }
  }

  /** Refresh after a conflict or a vanished task: the folder reads its items again. */
  protected refreshAfterFailure(): void {
    this.moveFailure.set(null);
    void this.load();
  }

  protected toggle(): void {
    this.open.update((open) => !open);
  }

  /** Try again: focus goes to the toggle, since the button it was on leaves with the error block. */
  protected retry(): void {
    void this.load();
    focusAfterRender(() => this.toggleButton(), { injector: this.injector });
  }

  /** `?section=next|backlog` (#562): scrolls the heading into view and focuses it, like the push settings deep link. */
  focusHeading(): void {
    const heading = this.headingEl()?.nativeElement;
    if (heading === undefined) {
      return;
    }
    heading.scrollIntoView({ block: 'start' });
    heading.focus({ preventScroll: true });
  }

  /** Back online (the folders' `online` listener): an offline folder loads again. */
  onOnline(): void {
    if (this.state().kind === 'offline') {
      void this.load();
    }
  }

  protected laneName(status: string): string {
    this.lang();
    return laneNameOf(status, (key) => this.transloco.translate(key));
  }

  protected visible(column: StatusColumn): StatusColumn['issues'] {
    return visibleItemsOf(column.issues, this.limitOf(column.status));
  }

  protected hidden(column: StatusColumn): number {
    return hiddenCountOf(column.issues, this.limitOf(column.status));
  }

  protected showMoreLabel(column: StatusColumn): string {
    const left = this.hidden(column);
    const lang = this.lang();
    return this.transloco.translate('board.sections.showMore', {
      n: localNumberOf(Math.min(FOLDER_LANE_PAGE, left), lang),
      left: localNumberOf(left, lang),
    });
  }

  /** Adds the next rows in place; focus moves to the first new one so the next Tab continues the list. */
  protected showMore(status: string): void {
    const from = this.limitOf(status);
    this.shown.update((shown) => new Map(shown).set(status, from + FOLDER_LANE_PAGE));
    focusAfterRender(
      () => {
        const lane = [...this.host.nativeElement.querySelectorAll<HTMLElement>('tc-lane')].find(
          (element) => element.dataset['status'] === status,
        );
        const row = lane?.querySelectorAll<HTMLElement>('tc-list-row a')[from];
        return row === undefined ? null : new ElementRef(row);
      },
      { injector: this.injector },
    );
  }

  private sprintNumber(): number | null {
    return this.folder().sprint?.number ?? null;
  }

  /** A task left this folder or joined it; a folder never loaded only has its header count, kept by the folders. */
  private onMoved(move: ItemMove): void {
    const mine = this.sprintNumber();
    if (move.from !== mine && move.to !== mine) {
      return;
    }
    this.moveFailure.set(null);
    const state = this.state();
    if (state.kind !== 'loaded') {
      return;
    }
    const root = this.host.nativeElement;
    const number = move.item.number;
    const others = state.items.filter((item) => item.number !== number);
    if (move.from === mine) {
      if (!move.isUndo) {
        const target = focusAfterLeaving(root, number, () => this.headingEl()?.nativeElement ?? null);
        focusAfterRender(() => elementRefOf(target()), { injector: this.injector });
      }
      this.state.set({ kind: 'loaded', items: others });
      return;
    }
    this.state.set({ kind: 'loaded', items: [...others, move.item] });
    if (move.isUndo) {
      focusAfterRender(() => elementRefOf(moveButtonOf(root, number)), { injector: this.injector });
    } else {
      this.arrivals.update((arrivals) => [...arrivals.filter((n) => n !== number), number]);
    }
  }

  /** One of this folder's tasks took another place in its lane (#456): the lane follows, focus stays on its ⋯. */
  private onReordered(item: ItemDto): void {
    const state = this.state();
    if (item.sprint !== this.sprintNumber() || state.kind !== 'loaded') {
      return;
    }
    this.moveFailure.set(null);
    this.arrivals.update((arrivals) => arrivals.filter((n) => n !== item.number));
    this.state.set({ kind: 'loaded', items: placedInLane(state.items, item) });
    const root = this.host.nativeElement;
    focusAfterRender(() => elementRefOf(moveButtonOf(root, item.number)), { injector: this.injector });
  }

  private limitOf(status: string): number {
    return this.shown().get(status) ?? FOLDER_LANE_PAGE;
  }

  /** The folder's open items, every page; a later load or the folder's end drops an earlier answer. */
  private async load(): Promise<void> {
    const token = ++this.loadToken;
    const { sprint } = this.folder();
    this.state.set({ kind: 'loading' });
    const query = { sprint: sprint === null ? 'none' : String(sprint.number), state: 'open' };
    const read = await this.items.items(this.slug(), query, true);
    if (token !== this.loadToken) {
      return;
    }
    if (!read.ok) {
      this.state.set({ kind: read.reason === 'offline' ? 'offline' : 'error' });
      return;
    }
    this.arrivals.set([]);
    this.state.set({ kind: 'loaded', items: read.value.filter((item) => item.sprint === (sprint?.number ?? null)) });
  }
}
