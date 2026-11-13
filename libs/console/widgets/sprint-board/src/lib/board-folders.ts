import {
  ChangeDetectionStrategy,
  Component,
  computed,
  DestroyRef,
  effect,
  inject,
  input,
  output,
  signal,
  untracked,
  viewChildren,
} from '@angular/core';
import { ItemsApi } from '@console/entities/item';
import { boardSectionsOf } from '@console/entities/sprint';
import { TranslocoPipe } from '@console/shared/i18n';
import { Button, Icon, StateBlock } from '@console/shared/ui';
import { openSprintsOf, type TrackerSprintListDto } from '@shared/contracts';
import { BoardFolder, type BoardFolderSpec } from './board-folder';

let nextFoldersId = 0;

type FoldersState =
  | { readonly kind: 'loading' | 'error' | 'offline' }
  | { readonly kind: 'ready'; readonly list: TrackerSprintListDto };

/** The folders a sprint list gives: every open future sprint by demo date ("Next", then "Later"), then the backlog. */
export function boardFoldersOf(list: TrackerSprintListDto): readonly BoardFolderSpec[] {
  const { future } = boardSectionsOf(list.sprints, []);
  return [
    ...future.map(({ kind, sprint }) => ({ kind, sprint, openCount: sprint?.openCount ?? 0 })),
    { kind: 'backlog', sprint: null, openCount: list.backlogOpenCount },
  ];
}

/**
 * Next, later and backlog folders under a console-tracker project's current sprint (#557). Reads the sprint list
 * once for the headers; each folder loads its own items when shown and fails on its own. Owns the `online` listener:
 * an offline folder (or list) reloads when the network is back.
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
        <tc-board-folder [slug]="slug()" [folder]="folder" [attr.data-folder]="folder.kind" />
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

  readonly slug = input.required<string>();
  /** «Create a sprint» in the no-next-sprint state: the page opens its dialog, then calls `reload()`. */
  readonly createSprint = output<void>();

  protected readonly state = signal<FoldersState>({ kind: 'loading' });
  protected readonly noNextId = `tc-board-folders-no-next-${String(nextFoldersId++)}`;
  private readonly children = viewChildren(BoardFolder);
  private loadToken = 0;

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
        void this.load(slug);
      });
    });
    inject(DestroyRef).onDestroy(() => {
      this.loadToken += 1;
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

  /** A folder is one sprint (or the backlog) of one project: a new project never reuses another's folder state. */
  protected trackOf(folder: BoardFolderSpec): string {
    return `${this.slug()}:${folder.sprint === null ? 'backlog' : `sprint:${String(folder.sprint.number)}`}`;
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
