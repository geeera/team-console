import { DOCUMENT } from '@angular/common';
import { computed, inject, Injectable, signal } from '@angular/core';
import type { JobDto, JobEventDto } from '@shared/contracts';
import { currentJobsOf, isHeldJob, isLiveJob, jobsTileOf, recentJobsOf } from './job.model';
import type { JobFailure } from './job-failure';
import { JobsApi } from './jobs.api';

/** While a job is queued or held the view refreshes this often; a runner polls the queue every minute or so. */
export const JOBS_LIVE_POLL_MS = 10_000;
/** With nothing live, a refresh a minute is enough to notice a scheduled job. */
export const JOBS_IDLE_POLL_MS = 60_000;
/** Events kept per job: the newest ones, the view is a tail, not the whole log. */
export const JOB_EVENTS_KEPT = 100;

/**
 * - `loading` until the first read answered;
 * - `forbidden` — 403: this identity may not read the project's jobs;
 * - `error` — the first read failed (with `failure`); a later failed refresh keeps the jobs and sets `failure` only;
 * - `ready` with the jobs (possibly none — the view's empty state).
 */
export type JobsStatus = 'idle' | 'loading' | 'ready' | 'forbidden' | 'error';

/**
 * One project's queue as the board shows it (#464): its newest jobs and the events of the ones a runner holds, read
 * from the Worker and kept in memory only. Provided per view (the board), so two boards never share a project.
 * `watch` refreshes on a timer only while the page is visible: every `JOBS_LIVE_POLL_MS` with a job live, every
 * `JOBS_IDLE_POLL_MS` otherwise, and once at once when the page comes back.
 */
@Injectable()
export class JobsStore {
  private readonly api = inject(JobsApi);
  private readonly document = inject(DOCUMENT);
  private ticket = 0;

  readonly slug = signal<string | null>(null);
  readonly status = signal<JobsStatus>('idle');
  readonly failure = signal<JobFailure | null>(null);
  readonly refreshing = signal(false);
  readonly jobs = signal<readonly JobDto[]>([]);
  private readonly eventsByJob = signal<ReadonlyMap<string, readonly JobEventDto[]>>(new Map());
  /** Jobs whose last events read failed; the card says so instead of showing a log that stopped. */
  readonly eventFailures = signal<ReadonlySet<string>>(new Set());

  readonly current = computed(() => currentJobsOf(this.jobs()));
  readonly recent = computed(() => recentJobsOf(this.jobs()));
  readonly tile = computed(() => jobsTileOf(this.jobs()));
  readonly hasLive = computed(() => this.jobs().some(isLiveJob));

  eventsOf(jobId: string): readonly JobEventDto[] {
    return this.eventsByJob().get(jobId) ?? [];
  }

  /** Reads `slug` now and keeps it fresh until the returned function is called. */
  watch(slug: string): () => void {
    this.reset(slug);
    let timer: ReturnType<typeof setTimeout> | null = null;
    let stopped = false;
    let visibilityRefreshInFlight = false;
    const clear = (): void => {
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
    };
    const schedule = (): void => {
      clear();
      if (stopped || this.document.visibilityState !== 'visible') {
        return;
      }
      timer = setTimeout(() => void tick(), this.hasLive() ? JOBS_LIVE_POLL_MS : JOBS_IDLE_POLL_MS);
    };
    const tick = async (): Promise<void> => {
      await this.refresh();
      schedule();
    };
    const onVisibility = (): void => {
      if (this.document.visibilityState === 'visible') {
        // The tab can fire several visibilitychange events in quick succession (e.g. alt-tab bounce);
        // without this guard each one would start its own overlapping refresh.
        if (visibilityRefreshInFlight) {
          return;
        }
        visibilityRefreshInFlight = true;
        void tick().finally(() => {
          visibilityRefreshInFlight = false;
        });
      } else {
        clear();
      }
    };
    this.document.addEventListener('visibilitychange', onVisibility);
    void tick();
    return () => {
      stopped = true;
      clear();
      this.document.removeEventListener('visibilitychange', onVisibility);
      // A read still on its way must not land in the next project's view.
      this.ticket += 1;
    };
  }

  /** One read of the jobs, then the new events of every held job. Never throws. */
  async refresh(): Promise<void> {
    const slug = this.slug();
    if (slug === null) {
      return;
    }
    const ticket = ++this.ticket;
    if (this.status() === 'ready') {
      this.refreshing.set(true);
    }
    try {
      const read = await this.api.list(slug);
      if (ticket !== this.ticket) {
        return;
      }
      if (!read.ok) {
        this.fail(read.failure);
        return;
      }
      this.jobs.set(read.value.jobs);
      this.failure.set(null);
      this.status.set('ready');
      await this.readEvents(slug, ticket, read.value.jobs.filter(isHeldJob));
    } finally {
      if (ticket === this.ticket) {
        this.refreshing.set(false);
      }
    }
  }

  /** A job Run now just queued: shown at once, before the next read confirms it. */
  add(job: JobDto): void {
    if (job.projectSlug !== this.slug()) {
      return;
    }
    this.jobs.update((jobs) => [job, ...jobs.filter((row) => row.id !== job.id)]);
    if (this.status() !== 'ready') {
      this.status.set('ready');
    }
  }

  private reset(slug: string): void {
    this.ticket += 1;
    this.slug.set(slug);
    this.jobs.set([]);
    this.eventsByJob.set(new Map());
    this.eventFailures.set(new Set());
    this.failure.set(null);
    this.refreshing.set(false);
    this.status.set('loading');
  }

  private fail(failure: JobFailure): void {
    this.failure.set(failure);
    if (this.status() === 'ready') {
      return;
    }
    this.status.set(failure.kind === 'forbidden' ? 'forbidden' : 'error');
  }

  private async readEvents(slug: string, ticket: number, held: readonly JobDto[]): Promise<void> {
    const known = this.eventsByJob();
    // Unbounded on purpose: `held` is at most JOBS_PAGE_LIMIT (20) jobs, so this never fans out far enough
    // to need a concurrency cap.
    const reads = await Promise.all(
      held.map(async (job) => {
        const before = known.get(job.id) ?? [];
        const after = before.at(-1)?.seq ?? 0;
        return { job, before, read: await this.api.events(slug, job.id, after) };
      }),
    );
    if (ticket !== this.ticket) {
      return;
    }
    const next = new Map<string, readonly JobEventDto[]>();
    const failed = new Set<string>();
    for (const { job, before, read } of reads) {
      if (read.ok) {
        next.set(job.id, [...before, ...read.value.events].slice(-JOB_EVENTS_KEPT));
      } else {
        next.set(job.id, before);
        failed.add(job.id);
      }
    }
    // Events of a job that ended stay on screen until it leaves the list, so its last lines do not vanish.
    for (const job of this.jobs()) {
      const kept = known.get(job.id);
      if (!next.has(job.id) && kept !== undefined) {
        next.set(job.id, kept);
      }
    }
    this.eventsByJob.set(next);
    this.eventFailures.set(failed);
  }
}
