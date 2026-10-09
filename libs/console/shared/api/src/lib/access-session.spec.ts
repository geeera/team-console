import { HttpErrorResponse, HttpHeaders, HttpResponse } from '@angular/common/http';
import {
  RELOGIN_MARKER,
  isAccessSessionExpired,
  reloginUrlOf,
  stripReloginMarker,
  withoutReloginMarker,
} from './access-session';

const PROBLEM = 'application/problem+json; charset=utf-8';
const HTML = 'text/html; charset=utf-8';
const ORIGIN = 'https://team-console-dev.geeera.workers.dev';

function failure(init: {
  status: number;
  contentType?: string;
  url?: string;
  redirected?: boolean;
  responseType?: ResponseType;
  body?: unknown;
}): HttpErrorResponse {
  return new HttpErrorResponse({
    status: init.status,
    headers: new HttpHeaders(init.contentType === undefined ? {} : { 'Content-Type': init.contentType }),
    url: init.url ?? `${ORIGIN}/api/v1/projects`,
    error: init.body ?? null,
    ...(init.redirected === undefined ? {} : { redirected: init.redirected }),
    ...(init.responseType === undefined ? {} : { responseType: init.responseType }),
  });
}

const expired = (error: HttpErrorResponse): boolean => isAccessSessionExpired(error, error.error);

function problem(slug: string, status: number): object {
  return { type: `https://team-console/problems/${slug}`, title: 'Problem', status };
}

describe('isAccessSessionExpired', () => {
  it('is true for the opaque redirect a manual-redirect fetch gets from Access', () => {
    expect(expired(failure({ status: 0, responseType: 'opaqueredirect' }))).toBe(true);
  });

  it('is true for a response the browser reached through a redirect', () => {
    expect(expired(failure({ status: 200, contentType: 'application/json', redirected: true }))).toBe(true);
  });

  it.each([
    'https://geeera.cloudflareaccess.com/cdn-cgi/access/login/x',
    'https://CloudflareAccess.com/cdn-cgi/access/login',
  ])('is true for a response from the Access login host %s', (url) => {
    expect(expired(failure({ status: 0, url }))).toBe(true);
  });

  it('is false for a host that only ends in the Access domain name', () => {
    expect(expired(failure({ status: 0, url: 'https://evilcloudflareaccess.com/x' }))).toBe(false);
  });

  it('is true for a 401 with an HTML body (an Access login page)', () => {
    expect(expired(failure({ status: 401, contentType: HTML, body: '<!doctype html>' }))).toBe(true);
  });

  it('is false for a 403 with an HTML body that is not from Access (a Cloudflare WAF or rate-limit page)', () => {
    expect(expired(failure({ status: 403, contentType: HTML, body: '<!doctype html>Access denied' }))).toBe(false);
  });

  it.each(['access-missing', 'access-unverified'])('is true for our 401 %s', (slug) => {
    expect(expired(failure({ status: 401, contentType: PROBLEM, body: problem(slug, 401) }))).toBe(true);
  });

  it.each(['access-forbidden', 'access-misconfigured'])(
    'is false for our 401 %s — signing in again cannot fix it',
    (slug) => {
      expect(expired(failure({ status: 401, contentType: PROBLEM, body: problem(slug, 401) }))).toBe(false);
    },
  );

  it.each(['access-missing', 'access-unverified'])('is true for our 403 %s', (slug) => {
    expect(expired(failure({ status: 403, contentType: PROBLEM, body: problem(slug, 403) }))).toBe(true);
  });

  it.each(['csrf', 'github-owner-not-connected'])('is false for our JSON 403 %s', (slug) => {
    expect(expired(failure({ status: 403, contentType: PROBLEM, body: problem(slug, 403) }))).toBe(false);
  });

  it('is true for a 403 whose response came from the Access login host', () => {
    expect(
      expired(
        failure({
          status: 403,
          contentType: HTML,
          body: '<!doctype html>',
          url: 'https://geeera.cloudflareaccess.com/cdn-cgi/access/login/x',
        }),
      ),
    ).toBe(true);
  });

  it('is true for a 2xx HTML page where JSON was expected (the login page after a same-origin redirect)', () => {
    expect(expired(failure({ status: 200, contentType: HTML, body: '<!doctype html>' }))).toBe(true);
    const page = new HttpResponse({
      status: 200,
      body: '<!doctype html>',
      headers: new HttpHeaders({ 'Content-Type': HTML }),
    });
    expect(isAccessSessionExpired(page, page.body)).toBe(true);
  });

  it('is false for a JSON success', () => {
    const ok = new HttpResponse({
      status: 200,
      body: [],
      headers: new HttpHeaders({ 'Content-Type': 'application/json' }),
    });
    expect(isAccessSessionExpired(ok, ok.body)).toBe(false);
  });

  it.each([
    ['a dropped connection (status 0)', failure({ status: 0 })],
    ["the service worker's synthesised 504", failure({ status: 504 })],
    ['an HTML 502 from the edge', failure({ status: 502, contentType: HTML, body: '<!doctype html>' })],
    ['a JSON 404', failure({ status: 404, contentType: PROBLEM, body: problem('not-found', 404) })],
    ['a 401 without a body', failure({ status: 401 })],
  ])('is false for %s — a new login cannot fix it', (_, error) => {
    expect(expired(error)).toBe(false);
  });
});

describe('the sign-in marker', () => {
  it('adds the service-worker bypass to the current address, keeping its query and fragment', () => {
    const url = new URL(reloginUrlOf(`${ORIGIN}/p/demo/board?lane=review#top`));

    expect(url.pathname).toBe('/p/demo/board');
    expect(url.searchParams.get('lane')).toBe('review');
    expect(url.searchParams.get(RELOGIN_MARKER)).toBe('1');
    expect(url.hash).toBe('#top');
    // Angular's service worker tests exactly this on the request URL before it answers anything.
    expect(/[?&]ngsw-bypass(?:[=&]|$)/i.test(url.search)).toBe(true);
  });

  it('round-trips: removing the marker gives back the address the owner was on', () => {
    const href = `${ORIGIN}/overview?view=all#x`;

    expect(withoutReloginMarker(reloginUrlOf(href))).toBe(href);
    expect(withoutReloginMarker(href)).toBeNull();
  });

  it('strips the marker from the address bar without a navigation, and leaves a clean address alone', () => {
    const replaceState = vi.fn();
    const view = (href: string) =>
      ({ location: { href }, history: { state: { id: 1 }, replaceState } }) as unknown as Pick<
        Window,
        'location' | 'history'
      >;

    stripReloginMarker(view(`${ORIGIN}/overview?ngsw-bypass=1&view=all`));
    expect(replaceState).toHaveBeenCalledExactlyOnceWith({ id: 1 }, '', `${ORIGIN}/overview?view=all`);

    replaceState.mockClear();
    stripReloginMarker(view(`${ORIGIN}/overview`));
    expect(replaceState).not.toHaveBeenCalled();
  });
});
