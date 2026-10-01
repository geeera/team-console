import { DOCUMENT } from '@angular/common';
import { HttpClient } from '@angular/common/http';
import { computed, inject, Injectable, signal } from '@angular/core';
import { firstValueFrom } from 'rxjs';

export const NEEDS_YOU_URL = '/api/v1/needs-you';
/** Badges are a hint, not a feed: one poll a minute while the app is visible is enough. */
export const NEEDS_YOU_REFRESH_MS = 60_000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * The per-project count of "needs you" items in a `GET /api/v1/needs-you` body (`NeedsYouDto` of
 * `@shared/contracts`: `{ items }`, each item tagged with `project: { slug, name }`). Tolerant on purpose —
 * a bare array or a slug string also count, anything else is ignored — so a badge never breaks the shell.
 */
export function countNeedsYouBySlug(body: unknown): Readonly<Record<string, number>> {
  const items = Array.isArray(body)
    ? body
    : isRecord(body) && Array.isArray(body['items'])
      ? body['items']
      : [];
  const counts: Record<string, number> = {};
  for (const item of items) {
    if (!isRecord(item)) {
      continue;
    }
    const project = item['project'];
    const slug = typeof project === 'string' ? project : isRecord(project) ? project['slug'] : undefined;
    if (typeof slug === 'string' && slug !== '') {
      counts[slug] = (counts[slug] ?? 0) + 1;
    }
  }
  return counts;
}

/**
 * Open "needs you" items per project slug, for the switcher badges. A failed refresh keeps the last
 * counts (a stale badge beats a flickering one) and never surfaces as a UI error.
 */
@Injectable({ providedIn: 'root' })
export class NeedsYouCounts {
  private readonly http = inject(HttpClient);
  private readonly document = inject(DOCUMENT);

  private inFlight: Promise<void> | null = null;

  readonly counts = signal<Readonly<Record<string, number>>>({});
  readonly total = computed(() => Object.values(this.counts()).reduce((sum, count) => sum + count, 0));

  countOf(slug: string): number {
    return this.counts()[slug] ?? 0;
  }

  refresh(): Promise<void> {
    if (this.inFlight !== null) {
      return this.inFlight;
    }
    this.inFlight = (async () => {
      try {
        const body = await firstValueFrom(this.http.get<unknown>(NEEDS_YOU_URL));
        this.counts.set(countNeedsYouBySlug(body));
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
