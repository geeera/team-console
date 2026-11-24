import { Injectable } from '@angular/core';
import type { SprintCiState } from '@shared/contracts';

/** Enough for every open pull request of the projects one owner switches between in a sitting. */
const MAX_REMEMBERED = 200;

/**
 * The CI state each pull request last showed in this session (#356). The board reloads whole (a loading state, then
 * fresh rows), so a chip alone never sees "running" turn into "passed"; this lets the chip that arrives after a reload
 * know what the owner saw before.
 */
@Injectable({ providedIn: 'root' })
export class SprintCiMemory {
  private readonly seen = new Map<string, SprintCiState>();

  recall(key: string): SprintCiState | null {
    return this.seen.get(key) ?? null;
  }

  remember(key: string, state: SprintCiState): void {
    // Re-inserting moves the key to the newest position, so the oldest is the one dropped on overflow.
    this.seen.delete(key);
    this.seen.set(key, state);
    if (this.seen.size > MAX_REMEMBERED) {
      const oldest = this.seen.keys().next();
      if (!oldest.done) {
        this.seen.delete(oldest.value);
      }
    }
  }
}
