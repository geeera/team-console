import { CHAT_TAB_ENABLED } from '@shared/contracts';

/** The sections of a project space, in tab order (ADR 0001 items 13–17); each one is a child route of `/p/:slug`. */
export const SPACE_SECTIONS = ['questions', 'chat', 'board', 'artifacts', 'demo'] as const;

export type SpaceSection = (typeof SPACE_SECTIONS)[number];

export const DEFAULT_SPACE_SECTION: SpaceSection = 'questions';

/**
 * The sections shown in the tab bar and offered as a navigation target. `chat` stays a valid, routable
 * section (see `isSpaceSection`) so an old deep link or saved path can still be recognised and redirected —
 * see `CHAT_TAB_ENABLED` (#203, brought back by #17).
 */
export const VISIBLE_SPACE_SECTIONS: readonly SpaceSection[] = SPACE_SECTIONS.filter(
  (section) => section !== 'chat' || CHAT_TAB_ENABLED,
);

export function isSpaceSection(value: unknown): value is SpaceSection {
  return typeof value === 'string' && (SPACE_SECTIONS as readonly string[]).includes(value);
}

/** A section that is actually reachable today — excludes `chat` while #17 is not shipped. */
export function isVisibleSpaceSection(value: unknown): value is SpaceSection {
  return isSpaceSection(value) && (VISIBLE_SPACE_SECTIONS as readonly string[]).includes(value);
}

/**
 * `/p/{slug}/{lastPath}`; an empty or missing last path, or one that points at a section that is not
 * currently visible (e.g. a `chat` saved before #203), opens the default section instead.
 */
export function spaceUrlOf(slug: string, lastPath: string | undefined): string {
  const firstSegment = lastPath?.split(/[/?#]/, 1)[0];
  const path = firstSegment !== undefined && firstSegment !== '' && isVisibleSpaceSection(firstSegment)
    ? lastPath
    : DEFAULT_SPACE_SECTION;
  return `/p/${encodeURIComponent(slug)}/${path}`;
}

const SPACE_URL = /^\/p\/([^/?#]+)(?:\/([^?#]*))?(\?[^#]*)?(#.*)?$/;

export interface SpaceLocation {
  readonly slug: string;
  /** Relative to `/p/{slug}/`, with the query but without the fragment; empty at the space root. */
  readonly path: string;
}

/** Where inside the spaces a router URL points, or null outside `/p/…`. */
export function spaceLocationOf(url: string): SpaceLocation | null {
  const match = SPACE_URL.exec(url);
  if (match === null || match[1] === undefined) {
    return null;
  }
  const slug = decodeURIComponent(match[1]);
  return { slug, path: `${match[2] ?? ''}${match[3] ?? ''}` };
}
