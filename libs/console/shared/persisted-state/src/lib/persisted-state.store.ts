import { DOCUMENT } from '@angular/common';
import { computed, DestroyRef, inject, Injectable, signal } from '@angular/core';
import {
  ArtifactFilter,
  emptyProjectUiState,
  parsePersistedState,
  PersistedStateV1,
  ProjectUiState,
  TASK_DRAFTS_MAX,
  TaskDraft,
} from './persisted-state.model';
import { PERSISTED_STATE_STORAGE } from './persisted-state.storage';

/** Scroll and path updates are frequent; at most one write per window is plenty. */
export const PERSISTED_STATE_WRITE_DELAY_MS = 250;

type Updater = (state: PersistedStateV1) => PersistedStateV1;

/**
 * Device-local UI state behind signals. Screens read and write here and never touch storage:
 * the store versions, validates, debounces and flushes (`visibilitychange` → hidden, `pagehide`).
 * The chat draft is written immediately because iOS may evict a backgrounded PWA at any time.
 */
@Injectable({ providedIn: 'root' })
export class PersistedStateStore {
  private readonly storage = inject(PERSISTED_STATE_STORAGE);
  private readonly document = inject(DOCUMENT);

  private readonly state = signal<PersistedStateV1>(parsePersistedState(this.storage.read()));
  private pendingWrite: ReturnType<typeof setTimeout> | null = null;
  private dirty = false;
  private reportedWriteFailure = false;

  readonly activeSlug = computed(() => this.state().activeSlug);
  readonly pinned = computed(() => this.state().pinned);
  readonly collapsed = computed(() => this.state().collapsed);
  readonly projects = computed(() => this.state().projects);

  constructor() {
    const flushWhenHidden = (): void => {
      if (this.document.visibilityState === 'hidden') {
        this.flush();
      }
    };
    const flush = (): void => this.flush();
    this.document.addEventListener('visibilitychange', flushWhenHidden);
    this.document.defaultView?.addEventListener('pagehide', flush);
    inject(DestroyRef).onDestroy(() => {
      this.document.removeEventListener('visibilitychange', flushWhenHidden);
      this.document.defaultView?.removeEventListener('pagehide', flush);
      this.flush();
    });
  }

  projectState(slug: string): ProjectUiState | undefined {
    return this.state().projects[slug];
  }

  isPinned(slug: string): boolean {
    return this.state().pinned.includes(slug);
  }

  setActiveSlug(slug: string | null): void {
    this.update((state) => (state.activeSlug === slug ? state : { ...state, activeSlug: slug }));
  }

  setLastPath(slug: string, lastPath: string): void {
    this.updateProject(slug, (project) =>
      project.lastPath === lastPath ? project : { ...project, lastPath },
    );
  }

  setScroll(slug: string, key: string, top: number): void {
    this.updateProject(slug, (project) =>
      project.scroll[key] === top ? project : { ...project, scroll: { ...project.scroll, [key]: top } },
    );
  }

  scrollOf(slug: string, key: string): number {
    return this.state().projects[slug]?.scroll[key] ?? 0;
  }

  setChatDraft(slug: string, chatDraft: string): void {
    this.updateProject(
      slug,
      (project) => (project.chatDraft === chatDraft ? project : { ...project, chatDraft }),
      {
        immediate: true,
      },
    );
  }

  /** The Artifacts filter of a project; empty fields are dropped, so a cleared filter is `{}`. */
  setArtifactFilter(slug: string, filter: ArtifactFilter): void {
    const next: ArtifactFilter = {
      ...(filter.type ? { type: filter.type } : {}),
      ...(filter.q ? { q: filter.q } : {}),
    };
    this.updateProject(slug, (project) => {
      const before = project.artifactFilter ?? {};
      if (before.type === next.type && before.q === next.q) {
        return project;
      }
      return { ...project, artifactFilter: next };
    });
  }

  /** The board's last tab on a narrow screen (#275), so the project opens on it again. */
  setBoardTab(slug: string, boardTab: string): void {
    this.updateProject(slug, (project) =>
      project.boardTab === boardTab ? project : { ...project, boardTab },
    );
  }

  /** Open board folders (#562): compared as a set, so toggling the same folders in another order never writes. */
  setBoardFolders(slug: string, folders: readonly string[]): void {
    this.updateProject(slug, (project) => {
      const before = new Set(project.boardFolders ?? []);
      const after = new Set(folders);
      if (before.size === after.size && [...before].every((key) => after.has(key))) {
        return project;
      }
      return { ...project, boardFolders: [...after] };
    });
  }

  taskDraftOf(slug: string, number: number): TaskDraft | undefined {
    return this.state().projects[slug]?.taskDrafts?.[String(number)];
  }

  /**
   * Keeps one part of a task's draft (`edit` or `comment`), written at once like the chat draft: iOS may evict a
   * backgrounded PWA at any time. `null` drops that part; a draft with no part left is removed.
   */
  setTaskDraft(
    slug: string,
    number: number,
    part: { readonly edit: TaskDraft['edit'] | null } | { readonly comment: string | null },
    savedAt: string = new Date().toISOString(),
  ): void {
    const key = String(number);
    this.updateProject(
      slug,
      (project) => {
        const drafts = { ...(project.taskDrafts ?? {}) };
        const before = drafts[key];
        const merged: Record<string, unknown> = { ...(before ?? {}), savedAt };
        if ('edit' in part) {
          if (part.edit === null) delete merged['edit'];
          else merged['edit'] = part.edit;
        } else if (part.comment === null || part.comment === '') {
          delete merged['comment'];
        } else {
          merged['comment'] = part.comment;
        }
        if (merged['edit'] === undefined && merged['comment'] === undefined) {
          if (before === undefined) {
            return project;
          }
          delete drafts[key];
        } else {
          drafts[key] = merged as unknown as TaskDraft;
        }
        // Bounded: the oldest drafts go first.
        const kept = Object.entries(drafts)
          .sort(([, a], [, b]) => b.savedAt.localeCompare(a.savedAt))
          .slice(0, TASK_DRAFTS_MAX);
        return { ...project, taskDrafts: Object.fromEntries(kept) };
      },
      { immediate: true },
    );
  }

  togglePin(slug: string): void {
    this.update((state) => ({
      ...state,
      pinned: state.pinned.includes(slug) ? state.pinned.filter((s) => s !== slug) : [...state.pinned, slug],
    }));
  }

  setCollapsed(collapsed: boolean): void {
    this.update((state) => (state.collapsed === collapsed ? state : { ...state, collapsed }));
  }

  /** Drops state of projects that are no longer active, so the stored object stays bounded. */
  prune(activeSlugs: readonly string[]): void {
    const keep = new Set(activeSlugs);
    this.update((state) => {
      const projects = Object.fromEntries(Object.entries(state.projects).filter(([slug]) => keep.has(slug)));
      const pinned = state.pinned.filter((slug) => keep.has(slug));
      const activeSlug = state.activeSlug !== null && keep.has(state.activeSlug) ? state.activeSlug : null;
      const unchanged =
        Object.keys(projects).length === Object.keys(state.projects).length &&
        pinned.length === state.pinned.length &&
        activeSlug === state.activeSlug;
      return unchanged ? state : { ...state, projects, pinned, activeSlug };
    });
  }

  /** Writes whatever is pending right now; safe to call when nothing is. */
  flush(): void {
    if (this.pendingWrite !== null) {
      clearTimeout(this.pendingWrite);
      this.pendingWrite = null;
    }
    if (!this.dirty) {
      return;
    }
    this.dirty = false;
    try {
      this.storage.write(JSON.stringify(this.state()));
    } catch (error: unknown) {
      // Quota or a disabled storage: the UI keeps working from memory; say so once, never throw.
      if (!this.reportedWriteFailure) {
        this.reportedWriteFailure = true;
        console.warn('persisted-state: could not write UI state; continuing in memory', error);
      }
    }
  }

  private updateProject(
    slug: string,
    change: (project: ProjectUiState) => ProjectUiState,
    options: { readonly immediate?: boolean } = {},
  ): void {
    this.update((state) => {
      const before = state.projects[slug] ?? emptyProjectUiState();
      const after = change(before);
      return after === before ? state : { ...state, projects: { ...state.projects, [slug]: after } };
    }, options);
  }

  private update(updater: Updater, options: { readonly immediate?: boolean } = {}): void {
    const before = this.state();
    const after = updater(before);
    if (after === before) {
      return;
    }
    this.state.set(after);
    this.dirty = true;
    if (options.immediate) {
      this.flush();
      return;
    }
    if (this.pendingWrite === null) {
      this.pendingWrite = setTimeout(() => {
        this.pendingWrite = null;
        this.flush();
      }, PERSISTED_STATE_WRITE_DELAY_MS);
    }
  }
}
