import { DOCUMENT } from '@angular/common';
import { computed, inject, Injectable, InjectionToken, signal } from '@angular/core';
import type { AnswerCommand } from '@shared/contracts';
import { isAnswerCommand } from '@shared/owner-grammar';

/**
 * An answer the owner gave from this device. The plugin keeps listing an answered issue until the team acts on
 * the answer (its labels change), so the console remembers the answer to show a receipt instead of the card.
 */
export interface AnsweredItem {
  readonly slug: string;
  readonly number: number;
  readonly command: AnswerCommand;
  /** The comment on GitHub (`AnswerResponse.url`). */
  readonly url: string;
  /** ISO 8601, when the console got the answer's response. */
  readonly answeredAt: string;
}

export const ANSWERED_ITEMS_KEY = 'tc.answered.v1';
/**
 * How long an answer hides its card while GitHub still lists the issue. The team's routine reads answers within the
 * hour; after this the card comes back, so a question the team asks again on the same issue is never hidden for good.
 */
export const ANSWERED_ITEMS_TTL_MS = 6 * 60 * 60 * 1000;
const MAX_ITEMS = 200;

/** The storage seam; tests supply an in-memory one. Device-local only, never sent to the Worker. */
export interface AnsweredItemsStorage {
  read(): string | null;
  /** May throw (quota, private mode); the store keeps working in memory. */
  write(value: string): void;
}

export const ANSWERED_ITEMS_STORAGE = new InjectionToken<AnsweredItemsStorage>('ANSWERED_ITEMS_STORAGE', {
  providedIn: 'root',
  factory: () => {
    const view = inject(DOCUMENT).defaultView;
    return {
      read: () => {
        try {
          return view?.localStorage.getItem(ANSWERED_ITEMS_KEY) ?? null;
        } catch {
          // Storage disabled: start empty, like a first launch.
          return null;
        }
      },
      write: (value) => view?.localStorage.setItem(ANSWERED_ITEMS_KEY, value),
    };
  },
});

/** Clock seam for the TTL. */
export const ANSWERED_ITEMS_NOW = new InjectionToken<() => number>('ANSWERED_ITEMS_NOW', {
  providedIn: 'root',
  factory: () => () => Date.now(),
});

export function answeredKeyOf(slug: string, number: number): string {
  return `${slug}#${number}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function isAnsweredItem(value: unknown): value is AnsweredItem {
  return (
    isRecord(value) &&
    typeof value['slug'] === 'string' &&
    value['slug'] !== '' &&
    Number.isSafeInteger(value['number']) &&
    isAnswerCommand(value['command']) &&
    typeof value['url'] === 'string' &&
    typeof value['answeredAt'] === 'string' &&
    !Number.isNaN(Date.parse(value['answeredAt']))
  );
}

/** Stored answers younger than the TTL; anything unreadable is dropped. */
export function parseAnsweredItems(raw: string | null, now: number): AnsweredItem[] {
  if (raw === null) {
    return [];
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    // A corrupt entry only costs the receipts; the cards show again.
    return [];
  }
  if (!Array.isArray(parsed)) {
    return [];
  }
  return parsed
    .filter(isAnsweredItem)
    .filter((item) => now - Date.parse(item.answeredAt) < ANSWERED_ITEMS_TTL_MS);
}

/**
 * The owner's answers given on this device that GitHub may still list as waiting. `NeedsYouCounts` leaves them
 * out of the badges and the question lists show a receipt in their place.
 */
@Injectable({ providedIn: 'root' })
export class AnsweredItems {
  private readonly storage = inject(ANSWERED_ITEMS_STORAGE);
  private readonly now = inject(ANSWERED_ITEMS_NOW);

  private readonly map = signal<ReadonlyMap<string, AnsweredItem>>(
    new Map(
      parseAnsweredItems(this.storage.read(), this.now()).map((item) => [
        answeredKeyOf(item.slug, item.number),
        item,
      ]),
    ),
  );

  readonly items = computed(() => [...this.map().values()]);

  get(slug: string, number: number): AnsweredItem | undefined {
    const item = this.map().get(answeredKeyOf(slug, number));
    if (item === undefined || this.now() - Date.parse(item.answeredAt) >= ANSWERED_ITEMS_TTL_MS) {
      return undefined;
    }
    return item;
  }

  has(slug: string, number: number): boolean {
    return this.get(slug, number) !== undefined;
  }

  record(item: AnsweredItem): void {
    const next = new Map(this.map());
    next.set(answeredKeyOf(item.slug, item.number), item);
    this.commit(next);
  }

  /**
   * Forgets the answers GitHub no longer lists for the projects that were just read: the team has acted on them.
   * Projects that were not read keep theirs.
   */
  reconcile(
    readSlugs: Iterable<string>,
    listed: Iterable<{ readonly slug: string; readonly number: number }>,
  ): void {
    const read = new Set(readSlugs);
    const stillListed = new Set([...listed].map((item) => answeredKeyOf(item.slug, item.number)));
    const next = new Map(
      [...this.map()].filter(([key, item]) => !read.has(item.slug) || stillListed.has(key)),
    );
    if (next.size !== this.map().size) {
      this.commit(next);
    }
  }

  private commit(next: Map<string, AnsweredItem>): void {
    const now = this.now();
    const kept = [...next].filter(([, item]) => now - Date.parse(item.answeredAt) < ANSWERED_ITEMS_TTL_MS);
    const trimmed = new Map(kept.slice(-MAX_ITEMS));
    this.map.set(trimmed);
    try {
      this.storage.write(JSON.stringify([...trimmed.values()]));
    } catch {
      // Quota or private mode: the receipts still hold for this session, which is what the owner sees now.
    }
  }
}
