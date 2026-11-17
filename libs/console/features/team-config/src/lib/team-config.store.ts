import { computed, inject, Injectable, signal } from '@angular/core';
import type { TeamConfigDto } from '@shared/contracts';
import { TeamConfigClient, type TeamConfigSaveResult } from './team-config.client';
import { changesOf, documentOf, draftOf, mergeOnTop, withLeaf, type DraftChange, type TeamDraft } from './team-draft';

export type TeamConfigStatus = 'loading' | 'ready' | 'error' | 'not-found';

/** What holds the page above the form until the owner acts (UX spec §2.5, §4). */
export type TeamConfigBanner =
  /** 412: `theirs` is the revision that won; nothing was written. */
  | { readonly kind: 'conflict'; readonly theirs: TeamConfigDto }
  /** After "Keep my edits on top": the values we both changed, mine kept, theirs one tap away. */
  | { readonly kind: 'merged'; readonly theirs: TeamConfigDto; readonly conflicts: readonly DraftChange[] }
  /** 403 on save: the caller no longer owns the project; the edits stay, read-only. */
  | { readonly kind: 'forbidden' };

/** An inline error: the copy key and its parameters, worded by the screen. */
export interface FieldError {
  readonly key: string;
  readonly params?: Readonly<Record<string, unknown>>;
}

/** Slow-load line after this long (UX spec §4 "Still loading"). */
export const SLOW_LOAD_MS = 3000;

/**
 * The state of one Settings › Team screen (#688): the stored view, the draft over it, the edits, the inline errors and
 * the banner. Provided by the editor, so it lives and dies with the screen. Nothing saves on change; `save` is the
 * one write, over the revision the draft was read from (`If-Match`), and it never overwrites a newer one.
 */
@Injectable()
export class TeamConfigStore {
  private readonly client = inject(TeamConfigClient);
  private slowTimer: ReturnType<typeof setTimeout> | null = null;

  readonly slug = signal('');
  readonly status = signal<TeamConfigStatus>('loading');
  readonly isSlow = signal(false);
  readonly view = signal<TeamConfigDto | null>(null);
  /** The draft of `view`: what the edits are counted against. */
  readonly base = signal<TeamDraft | null>(null);
  readonly draft = signal<TeamDraft | null>(null);
  /** Inline errors by document path: typed values out of their bound, and the field a 422 named. */
  readonly errors = signal<ReadonlyMap<string, FieldError>>(new Map());
  readonly banner = signal<TeamConfigBanner | null>(null);

  readonly changes = computed((): readonly DraftChange[] => {
    const base = this.base();
    const draft = this.draft();
    return base === null || draft === null ? [] : changesOf(base, draft);
  });
  readonly isDirty = computed(() => this.changes().length > 0);
  /** The owner, and not refused since: a 403 on save turns the screen read-only with the edits kept. */
  readonly canEdit = computed(() => (this.view()?.canManage ?? false) && this.banner()?.kind !== 'forbidden');

  async load(slug: string): Promise<void> {
    this.slug.set(slug);
    this.status.set('loading');
    this.isSlow.set(false);
    this.clearSlowTimer();
    this.slowTimer = setTimeout(() => this.isSlow.set(true), SLOW_LOAD_MS);
    const result = await this.client.load(slug);
    this.clearSlowTimer();
    if (!result.ok) {
      this.status.set(result.failure === 'not-found' ? 'not-found' : 'error');
      return;
    }
    this.adopt(result.view);
    this.status.set('ready');
  }

  /** One value of the draft; clears that value's error, since what was refused is gone. */
  edit(path: string, value: unknown): void {
    const draft = this.draft();
    if (draft === null) {
      return;
    }
    this.draft.set(withLeaf(draft, path, value));
    this.setError(path, null);
  }

  /** A whole new draft (a preset, a reset, the model sheet's two values). */
  replace(draft: TeamDraft, touched: readonly string[] = []): void {
    this.draft.set(draft);
    for (const path of touched) {
      this.setError(path, null);
    }
  }

  setError(path: string, error: FieldError | null): void {
    const next = new Map(this.errors());
    if (error === null) {
      next.delete(path);
    } else {
      next.set(path, error);
    }
    this.errors.set(next);
  }

  discard(): void {
    this.draft.set(this.base());
    this.errors.set(new Map());
    if (this.banner()?.kind === 'merged') {
      this.banner.set(null);
    }
  }

  /**
   * Saves the draft with `reason`. `saved` adopts the new revision; `stale` reads the revision that won and shows
   * the conflict banner; `forbidden` keeps the edits read-only; `invalid` and `hosted` mark the field.
   */
  async save(reason: string): Promise<TeamConfigSaveResult> {
    const view = this.view();
    const draft = this.draft();
    if (view === null || draft === null) {
      return { kind: 'failed' };
    }
    const result = await this.client.save(this.slug(), view.revision, documentOf(draft, view.config), reason);
    switch (result.kind) {
      case 'saved':
        this.adopt(result.view);
        this.banner.set(null);
        break;
      case 'invalid':
        this.setError(result.field, { key: 'teamConfig.error.invalid' });
        break;
      case 'hosted':
        this.setError('access.source', { key: 'teamConfig.access.hostedError' });
        break;
      case 'forbidden':
        this.banner.set({ kind: 'forbidden' });
        break;
      case 'stale':
        // Without their revision there is nothing to compare with: the owner tries again from the sheet.
        return (await this.readTheirs()) ? result : { kind: 'failed' };
      case 'failed':
        break;
    }
    return result;
  }

  /** "Keep my edits on top": their revision becomes the base, my changes go back over it. */
  keepMine(): readonly DraftChange[] {
    const banner = this.banner();
    const base = this.base();
    const draft = this.draft();
    if (banner?.kind !== 'conflict' || base === null || draft === null) {
      return [];
    }
    const { draft: merged, conflicts } = mergeOnTop(base, draft, draftOf(banner.theirs));
    this.adopt(banner.theirs, merged);
    this.banner.set(conflicts.length === 0 ? null : { kind: 'merged', theirs: banner.theirs, conflicts });
    return conflicts;
  }

  /** "Discard mine": their revision, no edits. */
  discardMine(): void {
    const banner = this.banner();
    if (banner?.kind === 'conflict' || banner?.kind === 'merged') {
      this.adopt(banner.theirs);
      this.banner.set(null);
    }
  }

  /** In the merged banner: take their value for one path we both changed. */
  takeTheirs(path: string): void {
    const banner = this.banner();
    if (banner?.kind !== 'merged') {
      return;
    }
    const conflict = banner.conflicts.find((change) => change.path === path);
    if (conflict !== undefined) {
      this.edit(path, conflict.from);
    }
  }

  closeMerged(): void {
    if (this.banner()?.kind === 'merged') {
      this.banner.set(null);
    }
  }

  /** What they changed from my base to their revision ("Show their changes"). */
  readonly theirChanges = computed((): readonly DraftChange[] => {
    const banner = this.banner();
    const base = this.base();
    return banner?.kind === 'conflict' && base !== null ? changesOf(base, draftOf(banner.theirs)) : [];
  });

  private async readTheirs(): Promise<boolean> {
    const latest = await this.client.load(this.slug());
    if (latest.ok) {
      this.banner.set({ kind: 'conflict', theirs: latest.view });
    }
    return latest.ok;
  }

  private adopt(view: TeamConfigDto, draft: TeamDraft = draftOf(view)): void {
    this.view.set(view);
    this.base.set(draftOf(view));
    this.draft.set(draft);
    this.errors.set(new Map());
  }

  private clearSlowTimer(): void {
    if (this.slowTimer !== null) {
      clearTimeout(this.slowTimer);
      this.slowTimer = null;
    }
  }
}
