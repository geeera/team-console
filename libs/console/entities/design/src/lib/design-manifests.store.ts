import { HttpErrorResponse } from '@angular/common/http';
import { ErrorHandler, inject, Injectable, signal, type Signal, type WritableSignal } from '@angular/core';
import { httpProblemOf } from '@console/shared/api';
import type { DesignManifest } from './design.model';
import { DesignsApi, UnexpectedDesignResponse } from './designs.api';

/**
 * Why a manifest could not be read: GitHub does not show the repository to the app (403/404), the device is offline,
 * GitHub asks to wait, or anything else.
 */
export type DesignFailure = 'no-access' | 'offline' | 'rate-limited' | 'unavailable';

export type DesignManifestState =
  | { readonly kind: 'loading' }
  | { readonly kind: 'ready'; readonly manifest: DesignManifest }
  | { readonly kind: 'failed'; readonly failure: DesignFailure };

const LOADING: DesignManifestState = { kind: 'loading' };

/**
 * One manifest per design issue, shared by every row, preview and viewer on screen (#277): the first reader loads
 * it, the others watch the same signal. A failure stays until `reload`, so a list does not hammer the Worker.
 */
@Injectable({ providedIn: 'root' })
export class DesignManifests {
  private readonly api = inject(DesignsApi);
  private readonly errors = inject(ErrorHandler);
  private readonly states = new Map<string, WritableSignal<DesignManifestState>>();

  /** The manifest's state; reading it starts the load when nothing has yet. */
  stateOf(slug: string, issue: number): Signal<DesignManifestState> {
    const key = `${slug}#${issue}`;
    const existing = this.states.get(key);
    if (existing !== undefined) {
      return existing.asReadonly();
    }
    const state = signal<DesignManifestState>(LOADING);
    this.states.set(key, state);
    void this.fill(slug, issue, state);
    return state.asReadonly();
  }

  /** Reads again (Retry, or a design that changed meanwhile). */
  async reload(slug: string, issue: number): Promise<void> {
    const key = `${slug}#${issue}`;
    const state = this.states.get(key) ?? signal<DesignManifestState>(LOADING);
    this.states.set(key, state);
    state.set(LOADING);
    await this.fill(slug, issue, state);
  }

  private async fill(slug: string, issue: number, state: WritableSignal<DesignManifestState>): Promise<void> {
    try {
      state.set({ kind: 'ready', manifest: await this.api.manifest(slug, issue) });
    } catch (error: unknown) {
      state.set({ kind: 'failed', failure: this.failureOf(error) });
    }
  }

  private failureOf(error: unknown): DesignFailure {
    if (!(error instanceof HttpErrorResponse)) {
      // A bad response shape, or a bug: the generic failure on screen, the cause to the error handler.
      if (!(error instanceof UnexpectedDesignResponse)) {
        this.errors.handleError(error);
      }
      return 'unavailable';
    }
    const problem = httpProblemOf(error);
    if (problem.slug === 'github-rate-limit' || problem.status === 429) {
      return 'rate-limited';
    }
    if (problem.status === 403 || problem.status === 404) {
      return 'no-access';
    }
    return problem.status === 0 ? 'offline' : 'unavailable';
  }
}
