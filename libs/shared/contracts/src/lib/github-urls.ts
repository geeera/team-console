const GITHUB_ORIGIN = 'https://github.com';
const AUTHORIZE_PATH = '/login/oauth/authorize';
// GitHub logins: alphanumerics and hyphens, not at either end, at most 39 characters.
const GITHUB_LOGIN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/;

function parsedUrl(value: unknown): URL | null {
  if (typeof value !== 'string') {
    return null;
  }
  try {
    return new URL(value);
  } catch {
    // Not an absolute URL at all: the callers treat that exactly like a foreign one.
    return null;
  }
}

/**
 * The only address Connect may navigate to (PR #42 security review): parsed strictly, the origin exactly
 * `https://github.com` (scheme, host and default port), the path exactly GitHub's OAuth authorize endpoint, no
 * credentials. A prefix match would let `https://github.com.evil.example/…` or `…/authorize/../x` through.
 */
export function isGitHubAuthorizeUrl(value: unknown): value is string {
  return githubAuthorizeUrlOf(value) !== null;
}

/** The checked authorize URL as the browser will see it (`URL.href`), or null; navigate to this, not the input. */
export function githubAuthorizeUrlOf(value: unknown): string | null {
  const url = parsedUrl(value);
  const isAuthorize =
    url !== null &&
    url.origin === GITHUB_ORIGIN &&
    url.pathname === AUTHORIZE_PATH &&
    url.username === '' &&
    url.password === '';
  return isAuthorize ? url.href : null;
}

/** A github.com page the console links to from server data (install page, authorized apps): https on github.com only. */
export function isGitHubPageUrl(value: unknown): value is string {
  const url = parsedUrl(value);
  return url !== null && url.origin === GITHUB_ORIGIN && url.username === '' && url.password === '';
}

/**
 * #792: 409 `github-permission-not-accepted`: the console app asks for a permission its installation has not accepted.
 * `settingsUrl` names the installation's settings page when the Worker knows the installation.
 */
export const PERMISSION_NOT_ACCEPTED_PROBLEM = 'github-permission-not-accepted';

/** The installation settings page of a `github-permission-not-accepted` problem, or `null` unless on github.com. */
export function permissionSettingsUrlOf(extensions: Readonly<Record<string, unknown>>): string | null {
  const url = extensions['settingsUrl'];
  return isGitHubPageUrl(url) ? url : null;
}

export function isGitHubLogin(value: unknown): value is string {
  return typeof value === 'string' && GITHUB_LOGIN.test(value);
}
