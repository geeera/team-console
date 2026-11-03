import { HttpErrorResponse } from '@angular/common/http';
import { computed, ErrorHandler, inject, Injectable, signal } from '@angular/core';
import { httpProblemOf } from '@console/shared/api';
import { ArtifactsSnapshot } from './artifact.model';
import { ArtifactsApi, UnexpectedArtifactsResponse } from './artifacts.api';

export type ArtifactsFailure = 'rate-limited' | 'not-installed' | 'offline' | 'unavailable';

export type ArtifactsState =
  | { readonly kind: 'idle' }
  | { readonly kind: 'loading'; readonly slug: string }
  | {
      readonly kind: 'ready';
      readonly slug: string;
      readonly snapshot: ArtifactsSnapshot;
      /** A reload is under way; the list stays on screen meanwhile. */
      readonly refreshing: boolean;
    }
  | { readonly kind: 'failed'; readonly slug: string; readonly failure: ArtifactsFailure };

/**
 * The open project's artifacts. One list at a time: switching projects drops the previous one, coming back to the
 * same project keeps the list on screen while it reloads. Search runs over this list in the browser.
 */
@Injectable({ providedIn: 'root' })
export class ArtifactsStore {
  private readonly api = inject(ArtifactsApi);
  private readonly errors = inject(ErrorHandler);
  private loadToken = 0;

  readonly state = signal<ArtifactsState>({ kind: 'idle' });
  readonly snapshot = computed(() => {
    const state = this.state();
    return state.kind === 'ready' ? state.snapshot : null;
  });

  async load(slug: string): Promise<void> {
    await this.fetch(slug, false);
  }

  /** "Check again": the Worker reads GitHub now instead of answering from its cache. */
  async checkAgain(): Promise<void> {
    const state = this.state();
    if (state.kind !== 'idle') {
      await this.fetch(state.slug, true);
    }
  }

  private async fetch(slug: string, fresh: boolean): Promise<void> {
    const token = ++this.loadToken;
    const current = this.state();
    if (current.kind === 'ready' && current.slug === slug) {
      this.state.set({ ...current, refreshing: true });
    } else {
      this.state.set({ kind: 'loading', slug });
    }
    try {
      const snapshot = await this.api.list(slug, { fresh });
      if (token === this.loadToken) {
        this.state.set({ kind: 'ready', slug, snapshot, refreshing: false });
      }
    } catch (error: unknown) {
      if (token === this.loadToken) {
        this.state.set({ kind: 'failed', slug, failure: this.failureOf(error) });
      }
    }
  }

  private failureOf(error: unknown): ArtifactsFailure {
    if (!(error instanceof HttpErrorResponse)) {
      // A bad response shape, or a bug: the generic failure on screen, the cause to the error handler.
      if (!(error instanceof UnexpectedArtifactsResponse)) {
        this.errors.handleError(error);
      }
      return 'unavailable';
    }
    const problem = httpProblemOf(error);
    if (problem.slug === 'github-rate-limit' || problem.status === 429) {
      return 'rate-limited';
    }
    if (problem.slug === 'github-app-not-installed') {
      return 'not-installed';
    }
    return problem.status === 0 ? 'offline' : 'unavailable';
  }
}
