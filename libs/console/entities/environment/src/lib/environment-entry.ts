import { countedMissingOf, type EnvironmentStatusDto } from '@shared/environment';

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
