import type { DomSanitizer, SafeResourceUrl } from '@angular/platform-browser';

/**
 * The only place the console turns a URL into a frame source (#20). Audited together with its spec: change the
 * checks only with a security review.
 */

// The `frame-src` families of apps/console/public/_headers; a frame outside them would be blocked silently by the
// CSP, so it is refused here and shown as a link instead. Keep both lists in step.
export const FRAME_HOST_SUFFIXES: readonly string[] = ['.pages.dev', '.workers.dev', '.github.io'];

const MAX_FRAME_URL_LENGTH = 2048;
// What the URL parser leaves of a DNS name; `*`, `_`, `%` and the brackets of an IPv6 literal fall outside it.
const DNS_HOST = /^[a-z0-9.-]+$/;
// WHATWG: a host whose last label is numeric is an IPv4 address (the parser has already normalised `0x7f.1` etc.).
const NUMERIC_LABEL = /^(?:0x[0-9a-f]*|[0-9]+)$/;

function isLoopbackOrIp(hostname: string): boolean {
  const last = hostname.split('.').at(-1) ?? '';
  return hostname === 'localhost' || hostname.endsWith('.localhost') || NUMERIC_LABEL.test(last);
}

function isInFrameFamily(hostname: string): boolean {
  return FRAME_HOST_SUFFIXES.some(
    (suffix) => hostname.endsWith(suffix) && hostname.length > suffix.length,
  );
}

/**
 * The URL a frame may load, or `null`: an absolute `https:` URL without credentials, on a DNS name (not an IP
 * address, not loopback, no trailing dot) inside the CSP's frame families, whose `origin` is exactly one of
 * `allowedOrigins` and is not `ownOrigin` (the console's own origin: a same-origin frame with `allow-scripts
 * allow-same-origin` could lift its own sandbox and act as the console). No prefix or substring matching. The result
 * is the parser's own serialisation of `candidate`.
 */
export function frameSrcOf(
  candidate: unknown,
  allowedOrigins: readonly string[],
  ownOrigin: string,
): string | null {
  if (typeof candidate !== 'string' || candidate.length > MAX_FRAME_URL_LENGTH || !URL.canParse(candidate)) {
    return null;
  }
  const url = new URL(candidate);
  const { hostname } = url;
  if (
    url.protocol !== 'https:' ||
    url.username !== '' ||
    url.password !== '' ||
    !DNS_HOST.test(hostname) ||
    hostname.endsWith('.') ||
    isLoopbackOrIp(hostname) ||
    !isInFrameFamily(hostname) ||
    url.origin === ownOrigin
  ) {
    return null;
  }
  return allowedOrigins.includes(url.origin) ? url.href : null;
}

/**
 * `frameSrcOf` marked as a trusted resource URL for `<iframe [src]>`. The one `bypassSecurityTrustResourceUrl` of the
 * console, reached only with a value that passed every check above.
 */
export function trustedFrameSrc(
  sanitizer: DomSanitizer,
  candidate: unknown,
  allowedOrigins: readonly string[],
  ownOrigin: string,
): SafeResourceUrl | null {
  const src = frameSrcOf(candidate, allowedOrigins, ownOrigin);
  return src === null ? null : sanitizer.bypassSecurityTrustResourceUrl(src);
}

/** A link target for the "open in a new tab" fallback: `https:` or `http:` only, else nothing to link to. */
export function externalHrefOf(candidate: unknown): string | null {
  if (typeof candidate !== 'string' || candidate.length > MAX_FRAME_URL_LENGTH || !URL.canParse(candidate)) {
    return null;
  }
  const url = new URL(candidate);
  return url.protocol === 'https:' || url.protocol === 'http:' ? url.href : null;
}
