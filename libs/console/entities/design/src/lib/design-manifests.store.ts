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

/** A list older than this is read again the next time someone looks at it (the team pushes to the design PR). */
export const DESIGN_MANIFEST_TTL_MS = 60_000;

const LOADING: DesignManifestState = { kind: 'loading' };

interface Entry {
  readonly state: WritableSignal<DesignManifestState>;
  /** When the current `ready` manifest arrived; `0` while none has. */
  loadedAt: number;
  /** A read is under way; a second ask joins it instead of starting another. */
  pending: Promise<void> | null;
  /** The manifest sha a 404 of one of its files already made us refetch for; one recovery per sha. */
  recoveredFor: string | null;
}

/**
 * One manifest per design issue, shared by every row, preview and viewer on screen (#277): the first reader loads
 * it, the others watch the same signal. The list is never trusted for long: the file route serves only the commit
 * the Worker picks right now, so a list older than `DESIGN_MANIFEST_TTL_MS` is read again on the next look, opening
 * the viewer and «Проверить снова» read again, and a file that answers 404 makes its reader refetch the list once.
 * A refetch keeps the current manifest on screen until the new one arrives; only a failed or missing one shows
 * loading.
 */
@Injectable({ providedIn: 'root' })
export class DesignManifests {
  private readonly api = inject(DesignsApi);
  private readonly errors = inject(ErrorHandler);
  private readonly entries = new Map<string, Entry>();
  /** Milliseconds since the epoch; a seam for the TTL specs. */
  now: () => number = () => Date.now();

  /** The manifest's state; reading it starts the load when nothing has yet, or a refresh when the list is old. */
  stateOf(slug: string, issue: number): Signal<DesignManifestState> {
    const entry = this.entryOf(slug, issue);
    const state = entry.state();
    const isStale = state.kind === 'ready' && this.now() - entry.loadedAt >= DESIGN_MANIFEST_TTL_MS;
    if (state.kind === 'loading' || isStale) {
      void this.fill(slug, issue, entry);
    }
    return entry.state.asReadonly();
  }

  /** Reads again (opening the viewer, Retry, «Проверить снова»); a ready manifest stays on screen meanwhile. */
  async reload(slug: string, issue: number): Promise<void> {
    await this.fill(slug, issue, this.entryOf(slug, issue));
  }

  /** Every manifest of a project read again — the Artifacts «Проверить снова». */
  async reloadAll(slug: string): Promise<void> {
    const prefix = `${slug}#`;
    await Promise.all(
      [...this.entries.entries()]
        .filter(([key]) => key.startsWith(prefix))
        .map(([key, entry]) => this.fill(slug, Number(key.slice(prefix.length)), entry)),
    );
  }

  /**
   * A file of the manifest at `sha` answered 404: the design moved to another commit. Refetches the list once per
   * sha and says whether it did, so the reader retries after the new list instead of showing the failure at once.
   */
  async recover(slug: string, issue: number, sha: string): Promise<boolean> {
    const entry = this.entryOf(slug, issue);
    if (entry.recoveredFor === sha) {
      return false;
    }
    entry.recoveredFor = sha;
    await this.fill(slug, issue, entry);
    return true;
  }

  private entryOf(slug: string, issue: number): Entry {
    const key = `${slug}#${issue}`;
    const existing = this.entries.get(key);
    if (existing !== undefined) {
      return existing;
    }
    const entry: Entry = { state: signal<DesignManifestState>(LOADING), loadedAt: 0, pending: null, recoveredFor: null };
    this.entries.set(key, entry);
    return entry;
  }

  private fill(slug: string, issue: number, entry: Entry): Promise<void> {
    if (entry.pending !== null) {
      return entry.pending;
    }
    if (entry.state().kind === 'failed') {
      entry.state.set(LOADING);
    }
    entry.pending = (async () => {
      try {
        const manifest = await this.api.manifest(slug, issue);
        entry.loadedAt = this.now();
        entry.state.set({ kind: 'ready', manifest });
      } catch (error: unknown) {
        // A refresh that fails keeps the manifest already on screen; only a first read shows the failure.
        if (entry.state().kind !== 'ready') {
          entry.state.set({ kind: 'failed', failure: this.failureOf(error) });
        }
      } finally {
        entry.pending = null;
      }
    })();
    return entry.pending;
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
