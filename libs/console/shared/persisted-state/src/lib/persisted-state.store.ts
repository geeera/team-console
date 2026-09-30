import { DOCUMENT } from '@angular/common';
import { computed, DestroyRef, inject, Injectable, signal } from '@angular/core';
import {
  emptyProjectUiState,
  parsePersistedState,
  PersistedStateV1,
  ProjectUiState,
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
