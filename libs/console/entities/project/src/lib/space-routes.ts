/** The sections of a project space, in tab order (ADR 0001 items 13–17); each one is a child route of `/p/:slug`. */
export const SPACE_SECTIONS = ['questions', 'chat', 'board', 'artifacts', 'demo'] as const;

export type SpaceSection = (typeof SPACE_SECTIONS)[number];

export const DEFAULT_SPACE_SECTION: SpaceSection = 'questions';

export function isSpaceSection(value: unknown): value is SpaceSection {
  return typeof value === 'string' && (SPACE_SECTIONS as readonly string[]).includes(value);
}

/** `/p/{slug}/{lastPath}`; an empty or missing last path opens the default section. */
export function spaceUrlOf(slug: string, lastPath: string | undefined): string {
  const path = lastPath === undefined || lastPath === '' ? DEFAULT_SPACE_SECTION : lastPath;
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
