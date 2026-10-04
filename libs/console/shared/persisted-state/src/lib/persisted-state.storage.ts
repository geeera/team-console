import { DOCUMENT } from '@angular/common';
import { inject, InjectionToken } from '@angular/core';
import { PERSISTED_STATE_KEY } from './persisted-state.model';

/** The one storage seam of the store; tests and Storybook supply an in-memory one. */
export interface PersistedStateStorage {
  /** Null when nothing is stored or storage is unavailable. */
  read(): string | null;
  /** May throw (quota, private mode); the store catches and reports once. */
  write(value: string): void;
}

export const PERSISTED_STATE_STORAGE = new InjectionToken<PersistedStateStorage>('PERSISTED_STATE_STORAGE', {
  providedIn: 'root',
  factory: () => localStorageAdapter(inject(DOCUMENT)),
});

function localStorageAdapter(document: Document): PersistedStateStorage {
  const view = document.defaultView;
  return {
    read: () => {
      try {
        return view?.localStorage.getItem(PERSISTED_STATE_KEY) ?? null;
      } catch {
        // Storage disabled (private mode with storage off): behave like a first launch.
        return null;
      }
    },
    write: (value) => {
      view?.localStorage.setItem(PERSISTED_STATE_KEY, value);
    },
  };
}

export function memoryPersistedStateStorage(initial: string | null = null): PersistedStateStorage & {
  value: string | null;
} {
  return {
    value: initial,
    read() {
      return this.value;
    },
    write(value: string) {
      this.value = value;
    },
  };
}
