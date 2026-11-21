/**
 * The sign-in pages `setup` may open in the operator's browser while `claude setup-token` runs (R-TOK-2): `https:`
 * only, the host exactly `claude.ai` or a subdomain of `anthropic.com`, no credentials or port in the URL. Judged
 * twice: by the runner's user before it asks, and by root before it opens.
 */

const URL_MAX_LENGTH = 2048;
const ANTHROPIC_SUFFIX = '.anthropic.com';

export function isSignInUrl(value: string): boolean {
  if (value.length > URL_MAX_LENGTH || /[\s\0]/.test(value)) {
    return false;
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    // Not a URL: never opened.
    return false;
  }
  const host = url.hostname;
  return (
    url.protocol === 'https:' &&
    url.username === '' &&
    url.password === '' &&
    url.port === '' &&
    (host === 'claude.ai' || (host.endsWith(ANTHROPIC_SUFFIX) && host.length > ANTHROPIC_SUFFIX.length))
  );
}
