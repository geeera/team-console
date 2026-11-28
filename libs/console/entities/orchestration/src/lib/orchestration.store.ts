import { DOCUMENT } from '@angular/common';
import { computed, inject, Injectable, signal } from '@angular/core';
import { IDLE_POLL_MS, LIVE_POLL_MS, pollWhileVisible } from '@console/shared/utils';
import type { OrchestrationDto } from '@shared/contracts';
import { OrchestrationApi } from './orchestration.api';
import type { OrchestrationFailure } from './orchestration-failure';
import { isRunActive } from './orchestration.model';

/**
 * - `loading` until the first read answered;
 * - `error` — the first read failed (with `failure`); a later failed refresh keeps the run and sets `failure` only;
 * - `ready` with the run (idle or not).
 */
export type OrchestrationStatus = 'idle' | 'loading' | 'ready' | 'error';

/**
 * One project's console-driven run as the board's controls show it (#1042), read from the Worker and kept in memory
 * only. Provided per view, so two boards never share a project. `watch` polls at the jobs list's cadence
 * (`LIVE_POLL_MS` while a run is on, `IDLE_POLL_MS` otherwise), only while the page is visible.
 */
@Injectable()
export class OrchestrationStore {
  private readonly api = inject(OrchestrationApi);
  private readonly document = inject(DOCUMENT);
  private ticket = 0;

  readonly slug = signal<string | null>(null);
  readonly status = signal<OrchestrationStatus>('idle');
  readonly run = signal<OrchestrationDto | null>(null);
  readonly failure = signal<OrchestrationFailure | null>(null);

  readonly isActive = computed(() => {
    const run = this.run();
    return run !== null && isRunActive(run);
  });

  /** Reads `slug` now and keeps it fresh until the returned function is called. */
  watch(slug: string): () => void {
    this.reset(slug);
    const stop = pollWhileVisible(
      this.document,
      async () => this.refresh(),
      () => (this.isActive() ? LIVE_POLL_MS : IDLE_POLL_MS),
    );
    return () => {
      stop();
      // A read still on its way must not land in the next project's controls.
      this.ticket += 1;
    };
  }

  /** One read of the run. Never throws. */
  async refresh(): Promise<void> {
    const slug = this.slug();
    if (slug === null) {
      return;
    }
    const ticket = ++this.ticket;
    const read = await this.api.get(slug);
    if (ticket !== this.ticket) {
      return;
    }
    if (read.ok) {
      this.apply(read.value);
      return;
    }
    this.failure.set(read.failure);
    if (this.status() !== 'ready') {
      this.status.set('error');
    }
  }

  /** The run a Start or Stop answered: shown at once; a read already on its way is dropped, it saw the run before. */
  apply(run: OrchestrationDto): void {
    this.ticket += 1;
    this.run.set(run);
    this.failure.set(null);
    this.status.set('ready');
  }

  private reset(slug: string): void {
    this.ticket += 1;
    this.slug.set(slug);
    this.run.set(null);
    this.failure.set(null);
    this.status.set('loading');
  }
}
