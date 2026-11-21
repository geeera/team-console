import { inject, Injectable, signal } from '@angular/core';
import type { ActionsSetupDto } from '@shared/contracts';
import type { ActionsCheckProblem } from './actions-setup-problems';
import { ActionsSetupApi } from './actions-setup.api';

/** The page's automatic re-check (tab back from GitHub) runs at most this often (UX spec §2 "Re-check"). */
export const ACTIONS_AUTO_RECHECK_MS = 30_000;

export type ActionsCheckState = 'idle' | 'loading' | 'ready' | 'error';

/**
 * One project's readiness check. Kept in memory only (never storage): every check mints a token at the Worker, so
 * the setup row, the Runners readiness line and the page share one answer per session instead of asking again.
 * The last good answer survives a failed re-check (shown with its time, offline included); a 403 or a 404 drops it.
 */
export class ActionsSetupState {
  private loadToken = 0;
  private lastAttemptAt = Number.NEGATIVE_INFINITY;

  readonly state = signal<ActionsCheckState>('idle');
  readonly problem = signal<ActionsCheckProblem | null>(null);
  readonly snapshot = signal<ActionsSetupDto | null>(null);

  constructor(
    private readonly api: ActionsSetupApi,
    readonly slug: string,
    private readonly now: () => number = Date.now,
  ) {}

  ensureLoaded(): Promise<void> {
    return this.state() === 'idle' ? this.load() : Promise.resolve();
  }

  /** The tab came back: one check, unless one ran within `ACTIONS_AUTO_RECHECK_MS`. Resolves whether it ran. */
  async autoRecheck(): Promise<boolean> {
    if (this.state() === 'loading' || this.now() - this.lastAttemptAt < ACTIONS_AUTO_RECHECK_MS) {
      return false;
    }
    await this.load();
    return true;
  }

  async load(): Promise<void> {
    const token = ++this.loadToken;
    this.lastAttemptAt = this.now();
    this.state.set('loading');
    const result = await this.api.check(this.slug);
    if (token !== this.loadToken) {
      return;
    }
    if (result.ok) {
      this.snapshot.set(result.value);
      this.problem.set(null);
      this.state.set('ready');
      return;
    }
    if (result.problem.kind === 'forbidden' || result.problem.kind === 'not-found') {
      this.snapshot.set(null);
    }
    this.problem.set(result.problem);
    this.state.set('error');
  }

  /** The switch's answer moves `dispatch` without another check (and its token). */
  applyDispatch(dispatch: ActionsSetupDto['dispatch']): void {
    const snapshot = this.snapshot();
    if (snapshot !== null) {
      this.snapshot.set({ ...snapshot, dispatch });
    }
  }
}

@Injectable({ providedIn: 'root' })
export class ActionsSetupStatuses {
  private readonly api = inject(ActionsSetupApi);
  private readonly byProject = new Map<string, ActionsSetupState>();

  of(slug: string): ActionsSetupState {
    let state = this.byProject.get(slug);
    if (state === undefined) {
      state = new ActionsSetupState(this.api, slug);
      this.byProject.set(slug, state);
    }
    return state;
  }
}
