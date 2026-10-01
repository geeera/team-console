import { DOCUMENT } from '@angular/common';
import { HttpClient } from '@angular/common/http';
import { computed, inject, Injectable, signal } from '@angular/core';
import type { NeedsYouItemDto } from '@shared/contracts';
import { firstValueFrom } from 'rxjs';
import { ProjectsStore } from './projects.store';
import { AnsweredItems } from './answered-items';

export const NEEDS_YOU_URL = '/api/v1/needs-you';
/** Badges are a hint, not a feed: one poll a minute while the app is visible is enough. */
export const NEEDS_YOU_REFRESH_MS = 60_000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** One waiting item as the badges need it: its project and, when the body carries it, its issue number. */
export interface NeedsYouRef {
  readonly slug: NeedsYouItemDto['project']['slug'];
  readonly number: NeedsYouItemDto['number'] | null;
}

/**
 * The waiting items of a `GET /api/v1/needs-you` body (`NeedsYouDto`: `{ items }`, each tagged with
 * `project: { slug, name }`). Tolerant on purpose — a bare array or a slug string also count, anything else is
 * ignored — so a badge never breaks the shell.
 */
export function needsYouRefsOf(body: unknown): NeedsYouRef[] {
  const items: unknown = Array.isArray(body) ? body : isRecord(body) ? body['items'] : undefined;
  if (!Array.isArray(items)) {
    return [];
  }
  const refs: NeedsYouRef[] = [];
  for (const item of items) {
    if (!isRecord(item)) {
      continue;
    }
    const project = item['project'];
    const slug = typeof project === 'string' ? project : isRecord(project) ? project['slug'] : undefined;
    if (typeof slug === 'string' && slug !== '') {
      const number = item['number'];
      refs.push({ slug, number: typeof number === 'number' && Number.isSafeInteger(number) ? number : null });
    }
  }
  return refs;
}

/**
 * Items per project slug. A `Map`, not an object: a slug such as `constructor` or `__proto__` must not meet
 * `Object.prototype`.
 */
export function countNeedsYouBySlug(body: unknown): ReadonlyMap<string, number> {
  return countRefs(needsYouRefsOf(body));
}

function countRefs(refs: readonly NeedsYouRef[]): ReadonlyMap<string, number> {
  const counts = new Map<string, number>();
  for (const { slug } of refs) {
    counts.set(slug, (counts.get(slug) ?? 0) + 1);
  }
  return counts;
}

/**
 * Open "needs you" items per project slug, for the switcher badges. A failed refresh keeps the last
 * counts (a stale badge beats a flickering one) and never surfaces as a UI error. Items the owner has
 * answered from this device are not counted while GitHub still lists them (`AnsweredItems`).
 */
@Injectable({ providedIn: 'root' })
export class NeedsYouCounts {
  private readonly http = inject(HttpClient);
  private readonly document = inject(DOCUMENT);
  private readonly projects = inject(ProjectsStore);

  private readonly answered = inject(AnsweredItems);

  private inFlight: Promise<void> | null = null;
  private readonly refs = signal<readonly NeedsYouRef[]>([]);

  readonly counts = computed(() =>
    countRefs(this.refs().filter((ref) => ref.number === null || !this.answered.has(ref.slug, ref.number))),
  );
  /** Active projects only once the list is known: an archived project leaves the badge at once (#24). */
  readonly total = computed(() => {
    const isKnown = this.projects.status() === 'ready';
    return [...this.counts().entries()]
      .filter(([slug]) => !isKnown || this.projects.isActive(slug))
      .reduce((sum, [, count]) => sum + count, 0);
  });

  countOf(slug: string): number {
    return this.counts().get(slug) ?? 0;
  }

  refresh(): Promise<void> {
    if (this.inFlight !== null) {
      return this.inFlight;
    }
    this.inFlight = (async () => {
      try {
        const body = await firstValueFrom(this.http.get<unknown>(NEEDS_YOU_URL));
        this.refs.set(needsYouRefsOf(body));
      } catch {
        // Unavailable (not yet deployed, offline, rate-limited): keep what we have; the shell shows no error for a badge.
      } finally {
        this.inFlight = null;
      }
    })();
    return this.inFlight;
  }

  /**
   * Refreshes now, when the app comes back to the foreground, and every minute while it is visible.
   * Returns the function that stops all of it; the shell ties it to its own destruction.
   */
  start(): () => void {
    let timer: ReturnType<typeof setInterval> | null = null;
    const stopTimer = (): void => {
      if (timer !== null) {
        clearInterval(timer);
        timer = null;
      }
    };
    const startTimer = (): void => {
      stopTimer();
      timer = setInterval(() => void this.refresh(), NEEDS_YOU_REFRESH_MS);
    };
    const onVisibility = (): void => {
      if (this.document.visibilityState === 'visible') {
        void this.refresh();
        startTimer();
      } else {
        stopTimer();
      }
    };
    this.document.addEventListener('visibilitychange', onVisibility);
    void this.refresh();
    if (this.document.visibilityState === 'visible') {
      startTimer();
    }
    return () => {
      stopTimer();
      this.document.removeEventListener('visibilitychange', onVisibility);
    };
  }
}
