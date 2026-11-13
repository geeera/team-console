import {
  afterNextRender,
  ChangeDetectionStrategy,
  Component,
  computed,
  DestroyRef,
  effect,
  inject,
  Injector,
  input,
  output,
  signal,
  untracked,
  viewChildren,
} from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { ItemsApi } from '@console/entities/item';
import { boardSectionsOf } from '@console/entities/sprint';
import { TranslocoPipe } from '@console/shared/i18n';
import { PersistedStateStore } from '@console/shared/persisted-state';
import { Button, Icon, StateBlock } from '@console/shared/ui';
import { openSprintsOf, type TrackerSprintListDto } from '@shared/contracts';
import { BoardFolder, type BoardFolderSpec } from './board-folder';
import { BoardMoves } from './board-moves';

let nextFoldersId = 0;

type FoldersState =
  | { readonly kind: 'loading' | 'error' | 'offline' }
  | { readonly kind: 'ready'; readonly list: TrackerSprintListDto };

/** The `?section=` values a deep link opens (#562); any other value is ignored, like `?tab=` for the board. */
export const BOARD_FOLDER_SECTIONS = ['next', 'backlog'] as const;
export type BoardFolderSection = (typeof BOARD_FOLDER_SECTIONS)[number];

export function isBoardFolderSection(value: unknown): value is BoardFolderSection {
  return typeof value === 'string' && (BOARD_FOLDER_SECTIONS as readonly string[]).includes(value);
}

/** The folders a sprint list gives: every open future sprint by demo date ("Next", then "Later"), then the backlog. */
export function boardFoldersOf(list: TrackerSprintListDto): readonly BoardFolderSpec[] {
  const { future } = boardSectionsOf(list.sprints, []);
  return [
    ...future.map(({ kind, sprint }) => ({ kind, sprint, openCount: sprint?.openCount ?? 0 })),
    { kind: 'backlog', sprint: null, openCount: list.backlogOpenCount },
  ];
}

/** The folder headers' open counts after an open task moved from one sprint (or the backlog) to another (#558). */
export function countsAfterMove(
  list: TrackerSprintListDto,
  from: number | null,
  to: number | null,
): TrackerSprintListDto {
  const delta = (sprint: number | null): number => (sprint === to ? 1 : 0) - (sprint === from ? 1 : 0);
  return {
    sprints: list.sprints.map((sprint) => ({ ...sprint, openCount: sprint.openCount + delta(sprint.number) })),
    backlogOpenCount: list.backlogOpenCount + delta(null),
  };
}

/** A folder's key in `ProjectUiState.boardFolders` (#562): scoped to the project already, so no slug in it. */
export function folderKeyOf(folder: BoardFolderSpec): string {
  return folder.sprint === null ? 'backlog' : `sprint:${String(folder.sprint.number)}`;
}

/**
 * Next, later and backlog folders under a console-tracker project's current sprint (#557). Reads the sprint list
 * once for the headers; each folder loads its own items when shown and fails on its own. Owns the `online` listener:
 * an offline folder (or list) reloads when the network is back.
 *
 * Open folders are remembered per project (#562, `tc.state.v1`) and restored on the next visit. A `?section=` deep
 * link opens that folder too (`next` or `backlog` only — there is at most one of each) and, once it is in the DOM,
 * scrolls to and focuses its heading.
 */
@Component({
  selector: 'tc-board-folders',
  imports: [BoardFolder, Button, Icon, StateBlock, TranslocoPipe],
  template: `
    @if (state().kind === 'loading') {
      <tc-state-block kind="loading" compact [title]="'board.loading' | transloco" />
    } @else if (state().kind === 'error' || state().kind === 'offline') {
      <tc-state-block
        kind="error"
        data-testid="folders-error"
        [icon]="state().kind === 'offline' ? 'offline' : null"
        [title]="'board.sections.listError' | transloco"
        [description]="(state().kind === 'offline' ? 'board.sections.offlineHint' : 'board.sections.errorHint') | transloco"
      >
        <button tc-button tc-state-action type="button" (click)="reload()">
          {{ 'board.sections.tryAgain' | transloco }}
        </button>
      </tc-state-block>
    }
    @if (isProjectEmpty()) {
      <tc-state-block
        kind="empty"
        data-testid="project-empty"
        [title]="'board.sections.emptyProject' | transloco"
        [description]="'board.sections.emptyProjectHint' | transloco"
      />
    } @else if (folders(); as folders) {
      @if (!hasFuture()) {
        <section class="folders__no-next" data-testid="no-next" [attr.aria-labelledby]="noNextId">
          <h2 class="folders__no-next-title" [id]="noNextId">{{ 'board.sections.next' | transloco }}</h2>
          <p class="folders__no-next-text">{{ 'board.sections.noNext' | transloco }}</p>
          <button tc-button size="sm" type="button" data-testid="folders-create-sprint" (click)="createSprint.emit()">
            <tc-icon name="plus" size="sm" />
            {{ 'sprintNew.create' | transloco }}
          </button>
        </section>
      }
      @for (folder of folders; track trackOf(folder)) {
        <tc-board-folder
          [slug]="slug()"
          [folder]="folder"
          [open]="isOpen(folder)"
          (openChange)="setOpen(folder, $event)"
          [attr.data-folder]="folder.kind"
        />
      }
    }
  `,
  styles: `
    :host {
      display: grid;
      gap: var(--space-3);
    }

    .folders__no-next {
      display: grid;
      justify-items: start;
      gap: var(--space-2);
    }

    .folders__no-next-title {
      margin: 0;
      font-size: var(--fs-xs);
      font-weight: var(--fw-bold);
      letter-spacing: var(--ls-caps);
      text-transform: uppercase;
      color: var(--text-2);
    }

    .folders__no-next-text {
      margin: 0;
      color: var(--text-2);
    }
  `,
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { '(window:online)': 'onOnline()' },
})
export class BoardFolders {
  private readonly items = inject(ItemsApi);
  private readonly persisted = inject(PersistedStateStore);
  private readonly injector = inject(Injector);

  readonly slug = input.required<string>();
  /** The board page's `?section=` (read like `?tab=`); anything but `next` or `backlog` is ignored. */
  readonly initialSection = input<string | null>(null);
  /** «Create a sprint» in the no-next-sprint state: the page opens its dialog, then calls `reload()`. */
  readonly createSprint = output<void>();

  protected readonly state = signal<FoldersState>({ kind: 'loading' });
  protected readonly noNextId = `tc-board-folders-no-next-${String(nextFoldersId++)}`;
  private readonly children = viewChildren(BoardFolder);
  private loadToken = 0;
  /** Open folder keys (`folderKeyOf`) for the current slug; seeded from storage, then kept in sync with it. */
  private readonly openKeys = signal<ReadonlySet<string>>(new Set());
  /** The sprint list's folders are known for the first time this visit: prune stale keys, apply the deep link once. */
  private readyHandled = false;

  protected readonly folders = computed(() => {
    const state = this.state();
    return state.kind === 'ready' ? boardFoldersOf(state.list) : null;
  });
  protected readonly hasFuture = computed(() => (this.folders() ?? []).some((folder) => folder.sprint !== null));
  /** No open sprint and nothing open in the backlog: the #409 project-empty state instead of folders. */
  protected readonly isProjectEmpty = computed(() => {
    const state = this.state();
    return state.kind === 'ready' && openSprintsOf(state.list.sprints).length === 0 && state.list.backlogOpenCount === 0;
  });

  constructor() {
    effect(() => {
      const slug = this.slug();
      untracked(() => {
        this.state.set({ kind: 'loading' });
        this.readyHandled = false;
        this.openKeys.set(new Set(this.persisted.projectState(slug)?.boardFolders ?? []));
        void this.load(slug);
      });
    });
    // Once the folders are known: drop keys for folders this project no longer has, then open the deep link's folder.
    effect(() => {
      const folders = this.folders();
      if (folders === null) {
        return;
      }
      untracked(() => this.onFoldersReady(folders));
    });
    inject(DestroyRef).onDestroy(() => {
      this.loadToken += 1;
    });
    inject(BoardMoves)
      .events.pipe(takeUntilDestroyed())
      .subscribe((event) => {
        const state = this.state();
        if (event.kind === 'moved' && event.move.item.state === 'open' && state.kind === 'ready') {
          this.state.set({ kind: 'ready', list: countsAfterMove(state.list, event.move.from, event.move.to) });
        }
      });
  }

  /** Reads the sprint list again (after a sprint was created, or Try again); loaded folders keep their state. */
  async reload(): Promise<void> {
    if (this.state().kind !== 'ready') {
      this.state.set({ kind: 'loading' });
    }
    await this.load(this.slug());
  }

  protected onOnline(): void {
    if (this.state().kind === 'offline') {
      void this.reload();
    }
    for (const folder of this.children()) {
      folder.onOnline();
    }
  }

  protected isOpen(folder: BoardFolderSpec): boolean {
    return this.openKeys().has(folderKeyOf(folder));
  }

  /** A shown or hidden folder (#562): kept in the device's state so the next visit opens on the same ones. */
  protected setOpen(folder: BoardFolderSpec, open: boolean): void {
    const key = folderKeyOf(folder);
    const before = this.openKeys();
    if (before.has(key) === open) {
      return;
    }
    const after = new Set(before);
    if (open) {
      after.add(key);
    } else {
      after.delete(key);
    }
    this.openKeys.set(after);
    this.persisted.setBoardFolders(this.slug(), [...after]);
  }

  /** A folder is one sprint (or the backlog) of one project: a new project never reuses another's folder state. */
  protected trackOf(folder: BoardFolderSpec): string {
    return `${this.slug()}:${folderKeyOf(folder)}`;
  }

  private onFoldersReady(folders: readonly BoardFolderSpec[]): void {
    if (this.readyHandled) {
      return;
    }
    this.readyHandled = true;
    const valid = new Set(folders.map(folderKeyOf));
    const kept = new Set([...this.openKeys()].filter((key) => valid.has(key)));
    const section = this.initialSection();
    const target = isBoardFolderSection(section) ? folders.find((folder) => folder.kind === section) : undefined;
    if (target !== undefined) {
      kept.add(folderKeyOf(target));
    }
    if (kept.size !== this.openKeys().size || [...kept].some((key) => !this.openKeys().has(key))) {
      this.openKeys.set(kept);
    }
    this.persisted.setBoardFolders(this.slug(), [...kept]);
    if (target !== undefined) {
      const key = folderKeyOf(target);
      afterNextRender(
        () => this.children().find((child) => folderKeyOf(child.folder()) === key)?.focusHeading(),
        { injector: this.injector },
      );
    }
  }

  private async load(slug: string): Promise<void> {
    const token = ++this.loadToken;
    const read = await this.items.sprintList(slug);
    if (token !== this.loadToken) {
      return;
    }
    if (read.ok) {
      this.state.set({ kind: 'ready', list: read.value });
    } else {
      this.state.set({ kind: read.reason === 'offline' ? 'offline' : 'error' });
    }
  }
}
