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
import { toSignal } from '@angular/core/rxjs-interop';
import { ItemsApi } from '@console/entities/item';
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
import { hiddenCountOf, laneNameOf, PREFERRED_LANES, visibleItemsOf } from './sprint-board';

/** Rows a folder lane adds per «Show 30 more» (#108 §2). */
export const FOLDER_LANE_PAGE = 30;

/** A folder as its header knows it before any item is read: the sprint (none for the backlog) and its open count. */
export type BoardFolderSpec = Pick<BoardSection, 'kind' | 'sprint' | 'openCount'>;

/** `idle` until first shown; a loaded folder keeps its rows while hidden (#557). */
export type BoardFolderState =
  | { readonly kind: 'idle' | 'loading' | 'error' | 'offline' }
  | { readonly kind: 'loaded'; readonly lanes: readonly StatusColumn[] };

const SKELETON_ROWS = [0, 1, 2] as const;

let nextFolderId = 0;

/**
 * One collapsed folder under the current sprint (#108, #409 §8): its header reads the sprint list only; Show tasks
 * loads the folder's own open items, once per visit. Hidden content stays rendered (`hidden`), so Show again does not
 * reload and the phone keeps the folder's lane. Lanes are those with items, in workflow order.
 */
@Component({
  selector: 'tc-board-folder',
  imports: [Button, Lane, Lanes, SprintItemList, StateBlock, TranslocoPipe],
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
    return state.kind === 'loaded' ? state.lanes : null;
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
  }

  protected toggle(): void {
    this.open.update((open) => !open);
  }

  /** Try again: focus goes to the toggle, since the button it was on leaves with the error block. */
  protected retry(): void {
    void this.load();
    focusAfterRender(() => this.toggleButton(), { injector: this.injector });
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

  private limitOf(status: string): number {
    return this.shown().get(status) ?? FOLDER_LANE_PAGE;
  }

  /** The folder's open items, every page; a later load or the folder's end drops an earlier answer. */
  private async load(): Promise<void> {
    const token = ++this.loadToken;
    const { kind, sprint } = this.folder();
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
    const lanes = sectionOf(kind, sprint, read.value).lanes.filter((lane) => lane.issues.length > 0);
    this.state.set({ kind: 'loaded', lanes });
  }
}
