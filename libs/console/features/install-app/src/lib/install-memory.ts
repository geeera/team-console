import { DOCUMENT } from '@angular/common';
import { computed, inject, Injectable, signal } from '@angular/core';
import { deviceStorageOf } from '@console/shared/platform';

/** This device's answer to the install card (#761 UX spec §3.5); never sent anywhere. */
export const INSTALL_PROMPT_KEY = 'tc.install-prompt.v1';
export const SNOOZE_DAYS = 14;
/** Owner decision on #761: a card shown on 3 launches with no answer snoozes itself, with no toast. */
export const IGNORED_LAUNCHES_LIMIT = 3;

const DAY_MS = 24 * 60 * 60 * 1000;
const SNOOZE_MS = SNOOZE_DAYS * DAY_MS;

/**
 * `open`: the card may be offered; `ignored` counts launches it was shown on without an answer. `snoozed` came from
 * Not now, a dismissed native dialog, or (`auto`) three ignored launches.
 */
export type InstallMemory =
  | { readonly choice: 'open'; readonly ignored: number }
  | { readonly choice: 'snoozed'; readonly until: string; readonly auto?: true }
  | { readonly choice: 'never' };

export const OPEN_MEMORY: InstallMemory = { choice: 'open', ignored: 0 };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Anything unreadable is a device that has not answered yet. */
export function parseInstallMemory(raw: string | null): InstallMemory {
  if (raw === null) {
    return OPEN_MEMORY;
  }
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    // A hand-edited or truncated value: the honest reading is "no answer".
    return OPEN_MEMORY;
  }
  if (!isRecord(value)) {
    return OPEN_MEMORY;
  }
  if (value['choice'] === 'never') {
    return { choice: 'never' };
  }
  if (value['choice'] === 'snoozed' && typeof value['until'] === 'string' && !Number.isNaN(Date.parse(value['until']))) {
    return value['auto'] === true
      ? { choice: 'snoozed', until: value['until'], auto: true }
      : { choice: 'snoozed', until: value['until'] };
  }
  const ignored = value['ignored'];
  return typeof ignored === 'number' && Number.isSafeInteger(ignored) && ignored > 0
    ? { choice: 'open', ignored }
    : OPEN_MEMORY;
}

export function serializeInstallMemory(memory: InstallMemory): string | null {
  switch (memory.choice) {
    case 'open':
      return memory.ignored === 0 ? null : JSON.stringify({ ignored: memory.ignored });
    case 'snoozed':
      return JSON.stringify(memory);
    case 'never':
      return JSON.stringify({ choice: 'never' });
  }
}

export function snoozedFrom(now: number, auto = false): InstallMemory {
  const until = new Date(now + SNOOZE_MS).toISOString();
  return auto ? { choice: 'snoozed', until, auto: true } : { choice: 'snoozed', until };
}

/**
 * The memory a new launch starts from: a snooze whose date has passed, or lies more than 14 days ahead (the clock
 * was moved back), has expired; the third ignored launch turns into a 14-day snooze and a fresh count after it.
 */
export function memoryAtLaunch(memory: InstallMemory, now: number): InstallMemory {
  if (memory.choice === 'snoozed') {
    const left = Date.parse(memory.until) - now;
    return left > 0 && left <= SNOOZE_MS ? memory : OPEN_MEMORY;
  }
  if (memory.choice === 'open' && memory.ignored >= IGNORED_LAUNCHES_LIMIT) {
    return snoozedFrom(now, true);
  }
  return memory;
}

/** Holds the answer for this launch even where storage is blocked; writes it through when it can. */
@Injectable({ providedIn: 'root' })
export class InstallMemoryStore {
  private readonly storage = deviceStorageOf(inject(DOCUMENT).defaultView, 'install prompt');
  private readonly state = signal(this.atLaunch());

  readonly memory = this.state.asReadonly();
  readonly canOffer = computed(() => this.state().choice === 'open');

  /** The card is on screen this launch: one more launch without an answer, until one comes. */
  markShown(): void {
    const memory = this.state();
    if (memory.choice === 'open') {
      this.save({ choice: 'open', ignored: memory.ignored + 1 });
    }
  }

  snooze(): void {
    this.save(snoozedFrom(Date.now()));
  }

  never(): void {
    this.save({ choice: 'never' });
  }

  /** Installed: nothing left to remember, and the count starts over if it is ever offered again. */
  clear(): void {
    this.save(OPEN_MEMORY);
  }

  private atLaunch(): InstallMemory {
    const stored = parseInstallMemory(this.storage.read(INSTALL_PROMPT_KEY));
    const memory = memoryAtLaunch(stored, Date.now());
    if (memory !== stored) {
      this.persist(memory);
    }
    return memory;
  }

  private save(memory: InstallMemory): void {
    this.state.set(memory);
    this.persist(memory);
  }

  private persist(memory: InstallMemory): void {
    const value = serializeInstallMemory(memory);
    if (value === null) {
      this.storage.remove(INSTALL_PROMPT_KEY);
    } else {
      this.storage.write(INSTALL_PROMPT_KEY, value);
    }
  }
}
