import {
  countedMissingOf,
  PROJECT_SECRETS_ENVIRONMENT,
  type EnvironmentStatusDto,
} from '@shared/environment';

// The Settings row reads this file and the store only — neither imports the manifest, so the guide prose stays in
// the Environment setup chunks.

/** The Settings row's chip (UX spec §3): it follows the same status call as the screen. */
export type EnvironmentEntryChip =
  | { readonly kind: 'checking' }
  | { readonly kind: 'missing'; readonly n: number }
  | { readonly kind: 'ok' }
  | { readonly kind: 'unknown' };

export function entryChipOf(
  state: 'idle' | 'loading' | 'ready' | 'error',
  snapshot: EnvironmentStatusDto | null,
): EnvironmentEntryChip {
  if (state === 'idle' || (state === 'loading' && snapshot === null)) {
    return { kind: 'checking' };
  }
  if (snapshot === null) {
    return { kind: 'unknown' };
  }
  const missing = countedMissingOf(snapshot);
  return missing > 0 ? { kind: 'missing', n: missing } : { kind: 'ok' };
}

/**
 * The project setup row's chip (#750 UX spec §6): "Checking…" while a call runs, "Not checked" after a failure or
 * where this console cannot see the project's secrets (they live in `PROJECT_SECRETS_ENVIRONMENT`), else the count.
 * The row itself shows only once a 200 was seen, so there is no chip for "never answered".
 */
export function projectEntryChipOf(
  state: 'idle' | 'loading' | 'ready' | 'error',
  snapshot: EnvironmentStatusDto | null,
): EnvironmentEntryChip {
  if (state === 'idle' || state === 'loading') {
    return { kind: 'checking' };
  }
  if (state === 'error' || snapshot === null || snapshot.environment !== PROJECT_SECRETS_ENVIRONMENT) {
    return { kind: 'unknown' };
  }
  const missing = countedMissingOf(snapshot);
  return missing > 0 ? { kind: 'missing', n: missing } : { kind: 'ok' };
}
