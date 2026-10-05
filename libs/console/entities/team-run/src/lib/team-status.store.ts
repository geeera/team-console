import { HttpClient, HttpErrorResponse } from '@angular/common/http';
import { inject, Injectable, signal } from '@angular/core';
import { httpProblemOf, type HttpProblem } from '@console/shared/api';
import type { SlotLock, TeamSlot, TeamState, TeamStatusDto } from '@shared/contracts';
import { firstValueFrom } from 'rxjs';
import { isTeamStatusDto, teamStatusUrl } from './team-status.model';

export type TeamStatusPhase = 'idle' | 'loading' | 'ready' | 'error';

/**
 * The team's state for the open project space (#114): what the run log says, read fresh by the Worker. The banner
 * and the Commands panel read one store, so a pause from either shows in both. After a command the store takes the
 * Worker's answer at once (`applyState`, `applyLock`) and reads the run log again in the background.
 */
@Injectable({ providedIn: 'root' })
export class TeamStatusStore {
  private readonly http = inject(HttpClient);
  private request = 0;

  readonly slug = signal<string | null>(null);
  readonly phase = signal<TeamStatusPhase>('idle');
  readonly status = signal<TeamStatusDto | null>(null);
  /** The failure of the last read, when it failed; the panel branches on its slug. */
  readonly problem = signal<HttpProblem | null>(null);
  /** A read in progress while a status is already shown (Refresh). */
  readonly refreshing = signal(false);

  /** Reads the status of `slug`; a different project than the one shown starts from loading. */
  async load(slug: string): Promise<void> {
    const ticket = ++this.request;
    if (this.slug() !== slug) {
      this.slug.set(slug);
      this.status.set(null);
      this.phase.set('loading');
    } else if (this.status() !== null) {
      this.refreshing.set(true);
    } else {
      this.phase.set('loading');
    }
    try {
      const body = await firstValueFrom(this.http.get<unknown>(teamStatusUrl(slug)));
      if (ticket !== this.request) {
        return;
      }
      if (!isTeamStatusDto(body)) {
        throw new Error('team status: unexpected response shape');
      }
      this.status.set(body);
      this.problem.set(null);
      this.phase.set('ready');
    } catch (error: unknown) {
      if (ticket !== this.request) {
        return;
      }
      // An answer we cannot read is a failure like any other: commands stay off until the state is known.
      this.problem.set(
        error instanceof HttpErrorResponse
          ? httpProblemOf(error)
          : { status: 200, slug: null, problem: null, extensions: {}, retryAfterSeconds: null },
      );
      // A status already shown stays (with its time); the panel says it could not refresh it.
      this.phase.set(this.status() === null ? 'error' : 'ready');
    } finally {
      if (ticket === this.request) {
        this.refreshing.set(false);
      }
    }
  }

  async refresh(): Promise<void> {
    const slug = this.slug();
    if (slug !== null) {
      await this.load(slug);
    }
  }

  /** A pause or resume the Worker confirmed. */
  applyState(state: TeamState, pausedAt: string | null): void {
    const status = this.status();
    if (status !== null) {
      this.status.set({ ...status, state, pausedAt: state === 'paused-by-owner' ? pausedAt : null });
    }
  }

  /** A slot the Worker locked (requested, no answer, or a run it found in the log). */
  applyLock(slot: TeamSlot, lock: SlotLock): void {
    const status = this.status();
    if (status !== null) {
      this.status.set({
        ...status,
        slots: status.slots.map((candidate) =>
          candidate.slot === slot ? { ...candidate, lock } : candidate,
        ),
      });
    }
  }
}
