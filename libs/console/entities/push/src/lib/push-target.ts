import { isValidSlug } from '@shared/contracts';

/**
 * Where a tapped notification may lead (#11 builds the URL on the server): the cross-project Needs you list, or one
 * question in its project. Anything else is ignored — a notification never navigates the app anywhere else.
 */
export type PushTarget =
  | { readonly kind: 'needs-you' }
  | { readonly kind: 'question'; readonly slug: string; readonly number: number };

const QUESTIONS_PATH = /^\/p\/([^/]+)\/questions$/;
// Any origin works as the base; the check is that the URL stays on it, i.e. is a same-origin path.
const BASE = 'https://console.invalid';

/** The `#n` of `/p/{slug}/questions#n`: digits only, a positive safe integer; anything else is no target. */
export function questionNumberOf(fragment: string | null | undefined): number | null {
  if (typeof fragment !== 'string' || !/^\d{1,15}$/.test(fragment)) {
    return null;
  }
  const number = Number(fragment);
  return Number.isSafeInteger(number) && number > 0 ? number : null;
}

export function pushTargetOf(url: unknown): PushTarget | null {
  if (typeof url !== 'string' || !url.startsWith('/') || url.startsWith('//') || url.includes('\\')) {
    return null;
  }
  let parsed: URL;
  try {
    parsed = new URL(url, BASE);
  } catch {
    return null;
  }
  // Canonical form only: a URL the parser had to rewrite (dot segments, escapes) is not one the Worker built.
  if (parsed.origin !== BASE || parsed.search !== '' || `${parsed.pathname}${parsed.hash}` !== url) {
    return null;
  }
  if (parsed.pathname === '/needs-you') {
    return parsed.hash === '' ? { kind: 'needs-you' } : null;
  }
  const match = QUESTIONS_PATH.exec(parsed.pathname);
  const slug = match?.[1];
  const number = questionNumberOf(parsed.hash.slice(1));
  if (slug === undefined || !isValidSlug(slug) || number === null || !parsed.hash.startsWith('#')) {
    return null;
  }
  return { kind: 'question', slug, number };
}
