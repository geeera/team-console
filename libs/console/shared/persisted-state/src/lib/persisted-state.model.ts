/**
 * Device-local UI state (ADR 0001, decision 23): where the owner was in every project space.
 * Nothing here ever leaves the device — the store has no HTTP dependency by design.
 */

export const PERSISTED_STATE_VERSION = 1;
export const PERSISTED_STATE_KEY = `tc.state.v${PERSISTED_STATE_VERSION}`;

export interface ArtifactFilter {
  readonly type?: string;
  readonly q?: string;
}

export interface ProjectUiState {
  /** Relative to `/p/{slug}/`, e.g. `artifacts?type=decisions`; empty until the space was visited. */
  readonly lastPath: string;
  /** Scroll top of the document (the one scroll, #274) per screen, keyed by `scrollKeyOf(lastPath)`. */
  readonly scroll: Readonly<Record<string, number>>;
  readonly chatDraft: string;
  readonly artifactFilter?: ArtifactFilter;
  readonly boardTab?: string;
}

export interface PersistedStateV1 {
  readonly version: typeof PERSISTED_STATE_VERSION;
  readonly activeSlug: string | null;
  /** Pin order is display order; pins are device-local, the registry has no such field. */
  readonly pinned: readonly string[];
  /** The "other projects" section of the switcher is folded. */
  readonly collapsed: boolean;
  readonly projects: Readonly<Record<string, ProjectUiState>>;
}

export function emptyProjectUiState(): ProjectUiState {
  return { lastPath: '', scroll: {}, chatDraft: '' };
}

export function emptyPersistedState(): PersistedStateV1 {
  return { version: PERSISTED_STATE_VERSION, activeSlug: null, pinned: [], collapsed: false, projects: {} };
}

/** The scroll position belongs to the screen, not to its query or fragment. */
export function scrollKeyOf(path: string): string {
  const end = path.search(/[?#]/);
  return end === -1 ? path : path.slice(0, end);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string');
}

function isScrollMap(value: unknown): value is Record<string, number> {
  return (
    isRecord(value) && Object.values(value).every((top) => typeof top === 'number' && Number.isFinite(top))
  );
}

function isArtifactFilter(value: unknown): value is ArtifactFilter {
  if (!isRecord(value)) {
    return false;
  }
  return (
    (value['type'] === undefined || typeof value['type'] === 'string') &&
    (value['q'] === undefined || typeof value['q'] === 'string')
  );
}

export function isProjectUiState(value: unknown): value is ProjectUiState {
  if (!isRecord(value)) {
    return false;
  }
  return (
    typeof value['lastPath'] === 'string' &&
    isScrollMap(value['scroll']) &&
    typeof value['chatDraft'] === 'string' &&
    (value['artifactFilter'] === undefined || isArtifactFilter(value['artifactFilter'])) &&
    (value['boardTab'] === undefined || typeof value['boardTab'] === 'string')
  );
}

/**
 * Structural guard over whatever `localStorage` holds. Every field is type-checked; unknown slugs are
 * fine (pruned later against the project list), an unknown version or shape is not.
 */
export function isPersistedStateV1(value: unknown): value is PersistedStateV1 {
  if (!isRecord(value) || value['version'] !== PERSISTED_STATE_VERSION) {
    return false;
  }
  const activeSlug = value['activeSlug'];
  const projects = value['projects'];
  return (
    (activeSlug === null || typeof activeSlug === 'string') &&
    isStringArray(value['pinned']) &&
    typeof value['collapsed'] === 'boolean' &&
    isRecord(projects) &&
    Object.values(projects).every(isProjectUiState)
  );
}

/** Whatever storage gives back becomes a valid state: garbage, an old version or a wrong shape start fresh. */
export function parsePersistedState(raw: string | null): PersistedStateV1 {
  if (raw === null || raw === '') {
    return emptyPersistedState();
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    // Not JSON at all (a truncated write, another app's value): nothing to restore.
    return emptyPersistedState();
  }
  return isPersistedStateV1(parsed) ? parsed : emptyPersistedState();
}
